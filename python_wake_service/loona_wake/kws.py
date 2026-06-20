"""KWS(唤醒词检测)。

设计要点:KWS 的唯一职责是"在某帧检测到唤醒词",吐出一个 t_kw 事件。
它**不决定**录音边界——边界由 VAD + Ring Buffer 决定。这是本方案解耦的关键。

后端可插拔:
- ScriptedKWS:   在指定帧号触发,用于单测/复现组句逻辑(无需任何模型)。
- OpenWakeWordKWS:开源 openWakeWord 封装,可接真实唤醒词模型。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, List, Optional, Protocol, Set

import numpy as np

from . import FRAME_SIZE, SAMPLE_RATE
from .audio import Frame


@dataclass
class KwsHit:
    """一次唤醒词命中。index 为命中时的帧号(统一时间轴上的 t_kw)。"""

    index: int
    score: float


class KWS(Protocol):
    """KWS 后端接口:逐帧处理,命中则返回 KwsHit,否则 None。"""

    def process(self, frame: Frame) -> Optional[KwsHit]: ...


class ScriptedKWS:
    """在预设帧号触发的"假"KWS,用于测试组句状态机(零依赖)。"""

    def __init__(self, hit_indices: Iterable[int], score: float = 0.9):
        self._hits: Set[int] = set(hit_indices)
        self._score = score

    def process(self, frame: Frame) -> Optional[KwsHit]:
        if frame.index in self._hits:
            return KwsHit(index=frame.index, score=self._score)
        return None


class OpenWakeWordKWS:
    """openWakeWord 封装(需 `pip install openwakeword`)。

    注意:真实唤醒词 "Loona" 需要训练自定义模型;原型阶段可先用内置模型
    (如 "hey_jarvis")跑通端到端,再替换为自训模型。

    openWakeWord 内部按 80ms(1280 样本)滑窗推理,这里把 10ms 帧累积后喂入。
    命中帧号对齐到推理窗口末尾(贴近唤醒词结束位置)。
    """

    WINDOW = 1280  # 80ms @16k

    def __init__(
        self,
        model_path: Optional[str] = None,
        wakeword: str = "hey_jarvis",
        threshold: float = 0.5,
        refractory_ms: int = 1000,
    ):
        from openwakeword.model import Model  # 延迟导入

        kwargs = {"wakeword_models": [model_path]} if model_path else {}
        self._model = Model(**kwargs)
        self._wakeword = wakeword
        self._threshold = threshold
        self._refractory = max(1, refractory_ms * SAMPLE_RATE // (1000 * FRAME_SIZE))
        self._buf = np.zeros(0, dtype=np.int16)
        self._cooldown_until = -1

    def process(self, frame: Frame) -> Optional[KwsHit]:
        self._buf = np.concatenate([self._buf, frame.pcm])
        if len(self._buf) < self.WINDOW:
            return None
        chunk, self._buf = self._buf[: self.WINDOW], self._buf[self.WINDOW :]
        scores = self._model.predict(chunk)
        score = float(scores.get(self._wakeword, max(scores.values(), default=0.0)))
        if score >= self._threshold and frame.index >= self._cooldown_until:
            self._cooldown_until = frame.index + self._refractory  # 不应期,防连发
            return KwsHit(index=frame.index, score=score)
        return None


class TorchKWS:
    """自训 Loona KWS 的流式封装(需 torch + torchaudio)。

    模型是"1s log-mel 窗口里有没有 loona"的二分类器;这里维护一个 1s 滚动缓冲,
    每隔 hop_ms 计算一次,概率超阈值且过了不应期就命中(吐 t_kw,不定边界)。
    """

    WIN = SAMPLE_RATE  # 1s

    def __init__(
        self,
        model_path: str,
        threshold: Optional[float] = None,
        hop_ms: int = 100,
        refractory_ms: int = 1000,
        consec: int = 3,
    ):
        import torch
        import torchaudio

        from .kws_model import KWSNet

        self._torch = torch
        ckpt = torch.load(model_path, map_location="cpu")
        self._mean, self._std = ckpt["mean"], ckpt["std"]
        self._thr = threshold if threshold is not None else ckpt["threshold"]
        self.model = KWSNet(ckpt["n_mels"])
        self.model.load_state_dict(ckpt["state_dict"])
        self.model.eval()
        self._melspec = torchaudio.transforms.MelSpectrogram(
            sample_rate=SAMPLE_RATE, n_fft=400, hop_length=160, n_mels=ckpt["n_mels"]
        )
        self._buf = np.zeros(self.WIN, dtype=np.int16)
        self._hop_frames = max(1, hop_ms * SAMPLE_RATE // (1000 * FRAME_SIZE))
        self._since_eval = 0
        self._refractory = max(1, refractory_ms * SAMPLE_RATE // (1000 * FRAME_SIZE))
        self._cooldown_until = -1
        self.last_score = 0.0
        self.consec = consec       # 需连续多少个窗口过阈值才确认(防一闪而过的误触)
        self._consec_hits = 0

    def process(self, frame: Frame) -> Optional[KwsHit]:
        # 1s 滚动缓冲
        self._buf = np.concatenate([self._buf[FRAME_SIZE:], frame.pcm])
        self._since_eval += 1
        if self._since_eval < self._hop_frames:
            return None
        self._since_eval = 0

        torch = self._torch
        pcm = torch.from_numpy(self._buf.astype("float32") / 32768.0)
        feat = torch.log(self._melspec(pcm) + 1e-6).unsqueeze(0).unsqueeze(0)
        feat = (feat - self._mean) / self._std
        with torch.inference_mode():
            score = torch.sigmoid(self.model(feat)).item()
        self.last_score = score
        # 连续确认:要求连续 consec 个窗口都过阈值,过滤一闪而过的误触
        if score >= self._thr:
            self._consec_hits += 1
        else:
            self._consec_hits = 0
        if (self._consec_hits >= self.consec
                and frame.index >= self._cooldown_until):
            self._cooldown_until = frame.index + self._refractory
            self._consec_hits = 0
            return KwsHit(index=frame.index, score=score)
        return None


class TwoStageKWS:
    """两级唤醒:stage-1(常开 TorchKWS)报警 → 二级验证器(序列 CRNN)复核。

    验证器只在 stage-1 命中时跑一次(平时零开销),专门拒掉 corona/monami 这类
    "频谱像但音素序列不同"的词。两级都通过才算真正唤醒。
    """

    WIN = SAMPLE_RATE
    BUF = int(1.5 * SAMPLE_RATE)   # 比 1s 窗大,留出对齐扫描余量

    def __init__(self, stage1: "TorchKWS", verifier_path: str,
                 verifier_thr: Optional[float] = None):
        import torch
        import torchaudio

        from .verifier_model import VerifierNet

        self._torch = torch
        self.stage1 = stage1
        ck = torch.load(verifier_path, map_location="cpu")
        self._mean, self._std = ck["mean"], ck["std"]
        self._vthr = verifier_thr if verifier_thr is not None else ck["threshold"]
        self.model = VerifierNet(ck["n_mels"])
        self.model.load_state_dict(ck["state_dict"])
        self.model.eval()
        self._melspec = torchaudio.transforms.MelSpectrogram(
            sample_rate=SAMPLE_RATE, n_fft=400, hop_length=160, n_mels=ck["n_mels"]
        )
        self._buf = np.zeros(self.BUF, dtype=np.int16)
        self.last_verify = 0.0

    def _verify(self) -> float:
        """在缓冲区内扫多个对齐位置取最高分:loona 在任一对齐处确认即可,
        而 corona 各对齐都低 → 既救召回又拒真实词。"""
        torch = self._torch
        best = 0.0
        step = FRAME_SIZE * 4  # 40ms
        for st in range(0, self.BUF - self.WIN + 1, step):
            seg = self._buf[st: st + self.WIN]
            pcm = torch.from_numpy(seg.astype("float32") / 32768.0)
            feat = torch.log(self._melspec(pcm) + 1e-6).unsqueeze(0).unsqueeze(0)
            feat = (feat - self._mean) / self._std
            with torch.inference_mode():
                best = max(best, torch.sigmoid(self.model(feat)).item())
        return best

    def process(self, frame: Frame) -> Optional[KwsHit]:
        self._buf = np.concatenate([self._buf[FRAME_SIZE:], frame.pcm])
        hit = self.stage1.process(frame)
        if hit is None:
            return None
        v = self._verify()
        self.last_verify = v
        return hit if v >= self._vthr else None


class SegmentVerifier:
    """段级二级验证器:在 Assembler 捞出的整句上复核(对齐干净,效果最好)。

    用法:pipeline 触发后,verifier.score(utterance.pcm) >= thr 才算真唤醒。
    序列 CRNN 看开头辅音,拒掉 corona/ramona 这类真实词,召回零损失。
    """

    WIN = SAMPLE_RATE

    def __init__(self, verifier_path: str, threshold: Optional[float] = None):
        import torch
        import torchaudio

        from .verifier_model import VerifierNet

        self._torch = torch
        ck = torch.load(verifier_path, map_location="cpu")
        self._mean, self._std = ck["mean"], ck["std"]
        self.threshold = threshold if threshold is not None else 0.5
        self.model = VerifierNet(ck["n_mels"])
        self.model.load_state_dict(ck["state_dict"])
        self.model.eval()
        self._melspec = torchaudio.transforms.MelSpectrogram(
            sample_rate=SAMPLE_RATE, n_fft=400, hop_length=160, n_mels=ck["n_mels"]
        )

    def score(self, pcm16: np.ndarray) -> float:
        """整段内扫多个 1s 对齐取最高分。"""
        torch = self._torch
        pcm = pcm16.astype("float32") / 32768.0
        if len(pcm) < self.WIN:
            pcm = np.concatenate([pcm, np.zeros(self.WIN - len(pcm), dtype="float32")])
        best = 0.0
        for st in range(0, max(1, len(pcm) - self.WIN + 1), FRAME_SIZE * 4):
            seg = torch.from_numpy(pcm[st: st + self.WIN])
            feat = torch.log(self._melspec(seg) + 1e-6).unsqueeze(0).unsqueeze(0)
            feat = (feat - self._mean) / self._std
            with torch.inference_mode():
                best = max(best, torch.sigmoid(self.model(feat)).item())
        return best

    def accept(self, pcm16: np.ndarray) -> bool:
        return self.score(pcm16) >= self.threshold


def detect_hits(frames: List[Frame], kws: KWS) -> List[KwsHit]:
    """离线辅助:跑完帧流返回所有命中。"""
    return [h for f in frames if (h := kws.process(f)) is not None]
