"""VAD(语音端点检测)。

分两层:
1. VAD 后端:逐帧判定 speech / non-speech。可插拔(EnergyVAD / WebRtcVAD / 自研)。
2. SegmentDetector:消费逐帧判定,做带去抖动 + hangover 的端点检测,
   流式吐出"句子开始 / 句子结束"事件。这是 post-roll 的来源,与具体 VAD 后端无关。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional, Protocol, Tuple, Union

import numpy as np

from . import FRAME_SIZE, SAMPLE_RATE
from .audio import Frame


class VAD(Protocol):
    """VAD 后端接口:逐帧返回是否语音。"""

    def is_speech(self, frame: Frame) -> bool: ...


class EnergyVAD:
    """纯 numpy 的能量门限 VAD。零依赖,用于原型与单测。

    用一个滑动噪声基底自适应,避免对绝对音量敏感。
    """

    def __init__(self, threshold_db: float = 6.0, noise_adapt: float = 0.02):
        self.threshold_db = threshold_db          # 高于噪声基底多少 dB 算语音
        self.noise_adapt = noise_adapt            # 噪声基底更新速率
        self._noise_rms = 50.0                    # 初始噪声基底(int16 量级)

    def is_speech(self, frame: Frame) -> bool:
        rms = float(np.sqrt(np.mean(frame.pcm.astype(np.float32) ** 2)) + 1e-6)
        ratio_db = 20.0 * np.log10(rms / (self._noise_rms + 1e-6))
        speech = ratio_db > self.threshold_db
        if not speech:  # 仅在非语音帧更新噪声基底
            self._noise_rms = (
                1 - self.noise_adapt
            ) * self._noise_rms + self.noise_adapt * rms
        return speech


class WebRtcVAD:
    """WebRTC VAD 封装(需 `pip install webrtcvad`)。aggressiveness 0~3。"""

    def __init__(self, aggressiveness: int = 2):
        import webrtcvad  # 延迟导入

        self._vad = webrtcvad.Vad(aggressiveness)

    def is_speech(self, frame: Frame) -> bool:
        # webrtcvad 要求 10/20/30ms 的 16bit PCM bytes,本工程帧正好 10ms
        return self._vad.is_speech(frame.pcm.tobytes(), SAMPLE_RATE)


class SileroVAD:
    """真·语音 VAD(Silero),挡环境噪音/非人声,只让人声进 KWS。

    Silero 按 512 样本(32ms)推理;本工程帧是 10ms,这里累积后判定,
    决策保持到下个判定点(per-frame 返回最近一次结果)。
    threshold 越高越严(挡更多噪音、也更易误杀短促人声)。
    手机端可换 silero 的 onnx 版或 webrtcvad,体积都很小。
    """

    CHUNK = 512

    def __init__(self, threshold: float = 0.5):
        import torch
        from silero_vad import load_silero_vad

        self._torch = torch
        self._model = load_silero_vad()
        self._thr = threshold
        self._buf = np.zeros(0, dtype=np.float32)
        self._last = False

    def is_speech(self, frame: Frame) -> bool:
        self._buf = np.concatenate([self._buf, frame.pcm.astype(np.float32) / 32768.0])
        while len(self._buf) >= self.CHUNK:
            chunk = self._buf[: self.CHUNK]
            self._buf = self._buf[self.CHUNK :]
            prob = self._model(self._torch.from_numpy(chunk), SAMPLE_RATE).item()
            self._last = prob >= self._thr
        return self._last


# --------------------------------------------------------------------------- #
# 端点检测状态机
# --------------------------------------------------------------------------- #
@dataclass
class SpeechStart:
    start_index: int


@dataclass
class SpeechEnd:
    start_index: int
    end_index: int  # 闭区间,含尾部 pad


VadEvent = Union[SpeechStart, SpeechEnd]


def _ms_to_frames(ms: int) -> int:
    return max(1, ms * SAMPLE_RATE // (1000 * FRAME_SIZE))


class SegmentDetector:
    """带去抖动 + hangover 的端点检测。

    参数:
    - start_ms:   连续多少 ms 语音才确认句子开始(去抖,防瞬时噪声触发)
    - hangover_ms:句中出现多少 ms 静音才判定句子结束(post-roll 关键参数)
    - pad_ms:     句首/句尾各外扩多少 ms,避免切字
    """

    def __init__(self, start_ms: int = 90, hangover_ms: int = 700, pad_ms: int = 100):
        self.start_count = _ms_to_frames(start_ms)
        self.hangover_count = _ms_to_frames(hangover_ms)
        self.pad = _ms_to_frames(pad_ms)

        self._triggered = False
        self._seg_start = 0
        self._speech_run = 0
        self._silence_run = 0
        self._last_speech_index = 0

    @property
    def in_speech(self) -> bool:
        return self._triggered

    def process(self, frame: Frame, is_speech: bool) -> Optional[VadEvent]:
        idx = frame.index
        if not self._triggered:
            if is_speech:
                self._speech_run += 1
                if self._speech_run >= self.start_count:
                    self._triggered = True
                    # 句首回溯到这串语音的真正起点再外扩 pad
                    self._seg_start = max(0, idx - self._speech_run + 1 - self.pad)
                    self._silence_run = 0
                    self._last_speech_index = idx
                    return SpeechStart(self._seg_start)
            else:
                self._speech_run = 0
            return None

        # 已在句子中
        if is_speech:
            self._silence_run = 0
            self._last_speech_index = idx
            return None
        self._silence_run += 1
        if self._silence_run >= self.hangover_count:
            seg_end = self._last_speech_index + self.pad  # 末个语音帧 + pad
            self._triggered = False
            self._speech_run = 0
            self._silence_run = 0
            return SpeechEnd(self._seg_start, seg_end)
        return None


def detect_segments(
    frames: List[Frame], vad: VAD, detector: Optional[SegmentDetector] = None
) -> List[Tuple[int, int]]:
    """离线辅助:跑完一段帧流,返回所有 (start_index, end_index) 句子区间。"""
    detector = detector or SegmentDetector()
    out: List[Tuple[int, int]] = []
    pending_start: Optional[int] = None
    for f in frames:
        ev = detector.process(f, vad.is_speech(f))
        if isinstance(ev, SpeechStart):
            pending_start = ev.start_index
        elif isinstance(ev, SpeechEnd):
            out.append((ev.start_index, ev.end_index))
            pending_start = None
    # 流结束时仍在句中:用最后语音帧收尾
    if detector.in_speech and pending_start is not None:
        out.append((pending_start, detector._last_speech_index + detector.pad))
    return out
