"""Pipeline:把音频源 → SegmentAssembler → 云端桩 串起来。

这是端到端的最小闭环:
  帧流 → 组句(端侧,高召回) → 上云判定(Device-Directed) → 决定是否响应
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Iterator, List, Optional

from . import cloud
from .assembler import SegmentAssembler, Utterance
from .audio import Frame
from .kws import KWS
from .vad import VAD


@dataclass
class PipelineOutput:
    utterance: Utterance
    cloud: cloud.CloudResult
    responded: bool   # 端云判定后,设备最终是否响应


class Pipeline:
    def __init__(
        self,
        vad: VAD,
        kws: KWS,
        *,
        respond_on_uncertain: bool = True,  # uncertain 时是否仍响应(可走澄清话术)
        auto_followup: bool = True,         # 响应后开免唤醒追问窗口(实验台可关)
        verifier=None,                      # 可选段级二级验证器(SegmentVerifier)
        on_output: Optional[Callable[[PipelineOutput], None]] = None,
        on_rejected: Optional[Callable[[PipelineOutput], None]] = None,
        **assembler_kwargs,
    ):
        self.assembler = SegmentAssembler(vad, kws, **assembler_kwargs)
        self.respond_on_uncertain = respond_on_uncertain
        self.auto_followup = auto_followup
        self.verifier = verifier
        self.on_output = on_output
        self.on_rejected = on_rejected

    def _judge(self, utt: Utterance) -> Optional[PipelineOutput]:
        # 段级二级验证器:拒掉 corona/ramona 这类音近真实词(召回零损失)
        if self.verifier is not None and not self.verifier.accept(utt.pcm):
            if self.on_rejected:
                self.on_rejected(PipelineOutput(utterance=utt, cloud=None, responded=False))
            return None
        transcript = cloud.transcribe(utt)
        result = cloud.is_device_directed(utt, transcript)
        responded = result.decision == "directed" or (
            result.decision == "uncertain" and self.respond_on_uncertain
        )
        out = PipelineOutput(utterance=utt, cloud=result, responded=responded)
        if responded and self.auto_followup:
            # 设备响应后开启免唤醒窗口,实现会话连续性
            self.assembler.arm_followup(utt.end_index)
        if self.on_output:
            self.on_output(out)
        return out

    def feed(self, frame: Frame) -> List[PipelineOutput]:
        outs = [self._judge(u) for u in self.assembler.process(frame)]
        return [o for o in outs if o is not None]

    def run(self, frames: Iterator[Frame]) -> List[PipelineOutput]:
        outs: List[PipelineOutput] = []
        for f in frames:
            outs += self.feed(f)
        for u in self.assembler.flush():
            outs.append(self._judge(u))
        return outs
