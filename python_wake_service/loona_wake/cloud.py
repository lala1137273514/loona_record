"""云端桩(Cloud stub)—— 演示端云分工的接口边界。

端侧只负责"高召回地把含唤醒词的整句捞出来";
"这句话是不是对设备说的"(Device-Directed)由云端判断,这里给出接口与一个
**规则版占位实现**。真实实现应替换为:ASR 文本 + 声学 embedding 的多模态分类器。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from .assembler import Utterance

Decision = Literal["directed", "not_directed", "uncertain"]


@dataclass
class CloudResult:
    transcript: str
    decision: Decision
    score: float
    note: str


def transcribe(utt: Utterance) -> str:
    """ASR 占位。真实实现接云端 ASR(整段 utt.pcm)。"""
    # TODO: 接入真实 ASR;原型阶段返回占位文本
    return f"<asr:{utt.duration_ms}ms,{utt.wake_position}>"


def is_device_directed(utt: Utterance, transcript: str) -> CloudResult:
    """Device-Directed 判定(规则版占位)。

    真实实现应融合:词法/语义(疑问/祈使/第二人称、唤醒词是呼语还是宾语)、
    唤醒词位置+韵律、声学特征、对话状态。这里仅用端侧已产出的结构化特征做演示,
    并对模糊情况返回 uncertain,体现"提及 vs 呼叫"需要语义模型兜底。
    """
    # follow-up 窗口内的句子:用户已明确唤醒过,直接定向
    if utt.reason == "followup_command":
        return CloudResult(transcript, "directed", 0.9, "follow-up 窗口内")

    # 裸唤醒:明确的呼叫
    if utt.wake_position == "bare":
        return CloudResult(transcript, "directed", 0.85, "裸唤醒,等待指令")

    # 句首唤醒(Loona…):非常像 one-shot 指令
    if utt.wake_position == "head":
        return CloudResult(transcript, "directed", 0.75, "句首唤醒 + 指令")

    # 句尾唤醒(…loona):可能是呼叫,也可能是"我们问问Loona吧"式提及
    # —— 这正是真实语义模型该发力的地方,占位逻辑返回 uncertain
    if utt.wake_position == "tail":
        return CloudResult(
            transcript, "uncertain", 0.5,
            "句尾唤醒:需语义模型区分『呼叫』vs『提及』",
        )

    return CloudResult(transcript, "uncertain", 0.4, "默认交语义模型裁决")
