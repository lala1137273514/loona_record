"""Loona 端侧"自然唤醒"原型。

核心思想:把唤醒词从"会话触发开关"重定义为"注意力信号",
把『分句(VAD)』与『唤醒(KWS)』解耦。真正发给云端的单位是
"包含唤醒词的那一整个 VAD 句子"(唤醒词前 + 后的全部有效语音)。

模块:
- audio:     音频源(wav / 麦克风)、分帧、Ring Buffer(pre-roll 来源)
- vad:       语音端点检测(post-roll 来源)
- kws:       唤醒词检测(只吐 t_kw 事件,不定边界)
- assembler: Segment Assembler 状态机(本方案核心)
- pipeline:  串联以上组件
"""

SAMPLE_RATE = 16000          # 采样率 16kHz
FRAME_MS = 10                # 基础帧长 10ms
FRAME_SIZE = SAMPLE_RATE * FRAME_MS // 1000   # = 160 samples/frame

__all__ = ["SAMPLE_RATE", "FRAME_MS", "FRAME_SIZE"]
