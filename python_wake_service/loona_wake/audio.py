"""音频 I/O、分帧、Ring Buffer。

约定:整条 pipeline 以 10ms / 160 样本的 int16 单声道帧为基本流动单位。
每帧带一个全局递增的 frame_index,作为后续 VAD / KWS / 组句的统一时间轴。
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from typing import Iterator, Optional

import numpy as np

from . import FRAME_SIZE, SAMPLE_RATE


@dataclass
class Frame:
    """一帧音频。index 是全局帧号,作为统一时间轴。"""

    index: int
    pcm: np.ndarray  # int16, shape=(FRAME_SIZE,)

    @property
    def t_ms(self) -> int:
        """该帧起点对应的毫秒时间戳。"""
        return self.index * (1000 * FRAME_SIZE // SAMPLE_RATE)


# --------------------------------------------------------------------------- #
# 音频源:统一产出 Frame 流
# --------------------------------------------------------------------------- #
def frames_from_array(pcm: np.ndarray) -> Iterator[Frame]:
    """从一段 int16 PCM 数组切出 10ms 帧流(尾部不足一帧的丢弃)。"""
    if pcm.dtype != np.int16:
        raise ValueError(f"需要 int16 PCM,收到 {pcm.dtype}")
    n_frames = len(pcm) // FRAME_SIZE
    for i in range(n_frames):
        chunk = pcm[i * FRAME_SIZE : (i + 1) * FRAME_SIZE]
        yield Frame(index=i, pcm=chunk)


def frames_from_wav(path: str) -> Iterator[Frame]:
    """从 wav 文件读取并产出帧流(自动转 16k 单声道 int16)。"""
    import soundfile as sf  # 延迟导入,避免无依赖时整个包不可用

    pcm, sr = sf.read(path, dtype="int16", always_2d=True)
    pcm = pcm[:, 0]  # 取第一声道
    if sr != SAMPLE_RATE:
        raise ValueError(
            f"wav 采样率 {sr} != {SAMPLE_RATE},请先重采样(原型阶段不内置重采样)"
        )
    return frames_from_array(pcm)


def frames_from_mic(device: Optional[int] = None) -> Iterator[Frame]:
    """从麦克风实时产出帧流。需要 sounddevice + portaudio。"""
    import queue

    import sounddevice as sd  # 延迟导入

    q: "queue.Queue[np.ndarray]" = queue.Queue()

    def _cb(indata, frames, time_info, status):  # noqa: ANN001
        if status:
            print(f"[mic] {status}")
        q.put(indata[:, 0].copy())

    idx = 0
    with sd.InputStream(
        samplerate=SAMPLE_RATE,
        channels=1,
        dtype="int16",
        blocksize=FRAME_SIZE,
        device=device,
        callback=_cb,
    ):
        while True:
            chunk = q.get()
            # blocksize 已设为 FRAME_SIZE,这里通常正好一帧
            if len(chunk) == FRAME_SIZE:
                yield Frame(index=idx, pcm=chunk)
                idx += 1


# --------------------------------------------------------------------------- #
# Ring Buffer:常驻缓存最近若干秒,提供"回溯取音频"能力(pre-roll 来源)
# --------------------------------------------------------------------------- #
class RingBuffer:
    """环形缓冲:保存最近 capacity_ms 毫秒的帧,支持按帧号区间回溯取音频。

    这是能捞回"唤醒词之前的话"的物理基础。
    """

    def __init__(self, capacity_ms: int = 8000):
        self.capacity_frames = capacity_ms * SAMPLE_RATE // (1000 * FRAME_SIZE)
        self._frames: deque[Frame] = deque(maxlen=self.capacity_frames)

    def push(self, frame: Frame) -> None:
        self._frames.append(frame)

    @property
    def earliest_index(self) -> Optional[int]:
        return self._frames[0].index if self._frames else None

    @property
    def latest_index(self) -> Optional[int]:
        return self._frames[-1].index if self._frames else None

    def collect(self, start_index: int, end_index: int) -> np.ndarray:
        """取 [start_index, end_index] 闭区间内的 PCM(超出缓存的部分自动截断)。

        返回拼接好的 int16 数组;若区间无交集返回空数组。
        """
        if not self._frames:
            return np.zeros(0, dtype=np.int16)
        base = self._frames[0].index
        lo = max(start_index, base) - base
        hi = min(end_index, self._frames[-1].index) - base
        if hi < lo:
            return np.zeros(0, dtype=np.int16)
        parts = [self._frames[i].pcm for i in range(lo, hi + 1)]
        return np.concatenate(parts)
