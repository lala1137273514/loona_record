"""Segment Assembler —— 本方案的核心状态机。

把三个解耦的信号重新组合:
- Ring Buffer 提供"回溯取音频"能力(pre-roll,唤醒词之前的话)
- SegmentDetector(VAD) 提供句子边界(post-roll,唤醒词之后的话)
- KWS 提供 t_kw 命中时间点

产出 Utterance = "包含唤醒词的那一整个 VAD 句子",直接对应"上云的单位"。

一个状态机覆盖全部场景:
- 唤醒词在句首/句中/句尾 → 都捞整句(因为我们取的是整个 VAD 句子)
- 两段式 backup(Loona→停顿→指令)→ bare-wake 后开 follow-up 窗口捕获后续句
- 会话连续性(回复后免唤醒)→ 复用 arm_followup() 对外接口
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from typing import Callable, Deque, List, Optional

import numpy as np

from . import FRAME_SIZE, SAMPLE_RATE
from .audio import Frame, RingBuffer
from .kws import KWS, KwsHit
from .vad import VAD, SegmentDetector, SpeechEnd, SpeechStart


def _ms_to_frames(ms: int) -> int:
    return max(1, ms * SAMPLE_RATE // (1000 * FRAME_SIZE))


@dataclass
class Utterance:
    """组装好的一句话,准备上云。"""

    pcm: np.ndarray          # int16 整句音频
    start_index: int         # 句子起点帧号(含 pre-roll)
    end_index: int           # 句子终点帧号(含 post-roll pad)
    reason: str              # "wake_in_segment" | "followup_command"
    kws_hit: Optional[KwsHit]                # 命中信息(followup 句可能为 None)
    speech_before_ms: int = 0  # 唤醒词之前的语音时长(供云端 DDSD / 位置判定)
    speech_after_ms: int = 0   # 唤醒词之后的语音时长
    is_bare_wake: bool = False  # 是否"只喊了唤醒词"(整句≈一个唤醒词长度)

    @property
    def duration_ms(self) -> int:
        return len(self.pcm) * 1000 // SAMPLE_RATE

    @property
    def wake_position(self) -> str:
        """唤醒词在句中的相对位置,云端 DDSD 的有用特征。

        注意:KWS 通常在唤醒词"结束"时命中,故 before 天然含唤醒词本身时长,
        不能用 before≈0 判 head。是否"裸唤醒"改由整句时长(is_bare_wake)判定。
        """
        if self.kws_hit is None:
            return "none"
        if self.is_bare_wake:
            return "bare"   # 只喊了 Loona
        # 比较唤醒词两侧内容多少:内容明显在后→head,明显在前→tail
        if self.speech_after_ms >= self.speech_before_ms:
            return "head"   # Loona今天天气
        return "tail"       # ...好看吗loona


class SegmentAssembler:
    """组句状态机。逐帧 process(),在句子结束时吐出 0 或多个 Utterance。"""

    def __init__(
        self,
        vad: VAD,
        kws: KWS,
        *,
        ring_capacity_ms: int = 8000,
        start_ms: int = 90,
        hangover_ms: int = 700,
        pad_ms: int = 100,
        max_utterance_ms: int = 15000,
        followup_ms: int = 2000,
        bare_wake_max_ms: int = 900,
        on_utterance: Optional[Callable[[Utterance], None]] = None,
    ):
        self.vad = vad
        self.kws = kws
        self.ring = RingBuffer(capacity_ms=ring_capacity_ms)
        self.detector = SegmentDetector(
            start_ms=start_ms, hangover_ms=hangover_ms, pad_ms=pad_ms
        )
        self.max_frames = _ms_to_frames(max_utterance_ms)
        self.followup_frames = _ms_to_frames(followup_ms)
        self.bare_wake_max_frames = _ms_to_frames(bare_wake_max_ms)
        self.on_utterance = on_utterance

        self._recent_hits: Deque[KwsHit] = deque()
        self._seg_start = 0
        self._followup_until = -1   # >=0 表示处于 follow-up 等待窗口
        self._capture_current = False  # 当前句是否因 follow-up 而需无条件捕获

    # ----------------------------------------------------------------- #
    # 对外接口
    # ----------------------------------------------------------------- #
    def arm_followup(self, now_index: int) -> None:
        """开启免唤醒 follow-up 窗口(如设备回复完毕后,实现会话连续性)。

        窗口内开始的下一句即使没有唤醒词,也会被当作有效话捕获上云。
        """
        self._followup_until = now_index + self.followup_frames

    def process(self, frame: Frame) -> List[Utterance]:
        self.ring.push(frame)

        # 1) KWS 命中收集(只记时间点,不定边界)
        hit = self.kws.process(frame)
        if hit is not None:
            self._recent_hits.append(hit)
        self._prune_hits()

        # 2) VAD 端点检测
        ev = self.detector.process(frame, self.vad.is_speech(frame))
        if isinstance(ev, SpeechStart):
            self._seg_start = ev.start_index
            # follow-up 窗口内开始的句子 → 无条件捕获
            self._capture_current = (
                self._followup_until >= 0 and ev.start_index <= self._followup_until
            )
            self._followup_until = -1  # 窗口被这句消费
            return []
        if isinstance(ev, SpeechEnd):
            return self._on_segment_end(ev.start_index, ev.end_index)
        return []

    def flush(self) -> List[Utterance]:
        """流结束时收尾:若仍在句中,用最后语音帧强制收句。"""
        if not self.detector.in_speech:
            return []
        end = self.detector._last_speech_index + self.detector.pad
        return self._on_segment_end(self._seg_start, end)

    # ----------------------------------------------------------------- #
    # 内部
    # ----------------------------------------------------------------- #
    def _on_segment_end(self, start: int, end: int) -> List[Utterance]:
        hits_in = [h for h in self._recent_hits if start <= h.index <= end]
        has_wake = bool(hits_in)
        capture = self._capture_current
        self._capture_current = False

        if not (has_wake or capture):
            return []  # 普通无关语音,直接丢弃(端侧不做语义判断)

        first_hit = hits_in[0] if hits_in else None
        # 裸唤醒判定:整句时长 ≈ 一个唤醒词长度,说明后面没跟指令
        is_bare = has_wake and (end - start + 1) <= self.bare_wake_max_frames
        utt = self._assemble(
            start, end, first_hit,
            reason="wake_in_segment" if has_wake else "followup_command",
            is_bare=is_bare,
        )

        # 两段式 backup:只喊了唤醒词 → 开 follow-up 等指令
        if is_bare:
            self._followup_until = end + self.followup_frames

        if self.on_utterance:
            self.on_utterance(utt)
        return [utt]

    def _assemble(
        self, start: int, end: int, hit: Optional[KwsHit], reason: str,
        is_bare: bool = False,
    ) -> Utterance:
        # 整句时长上限保护:超长则从句首裁剪,保留靠近末尾(通常含指令/唤醒词)的部分
        if end - start + 1 > self.max_frames:
            start = end - self.max_frames + 1
        pcm = self.ring.collect(start, end)

        before_ms = after_ms = 0
        if hit is not None:
            before_ms = max(0, (hit.index - start)) * 1000 * FRAME_SIZE // SAMPLE_RATE
            after_ms = max(0, (end - hit.index)) * 1000 * FRAME_SIZE // SAMPLE_RATE

        return Utterance(
            pcm=pcm,
            start_index=start,
            end_index=end,
            reason=reason,
            kws_hit=hit,
            speech_before_ms=before_ms,
            speech_after_ms=after_ms,
            is_bare_wake=is_bare,
        )

    def _prune_hits(self) -> None:
        earliest = self.ring.earliest_index
        if earliest is None:
            return
        while self._recent_hits and self._recent_hits[0].index < earliest:
            self._recent_hits.popleft()
