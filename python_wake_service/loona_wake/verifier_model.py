"""二级验证器:小型 CRNN(卷积前端 + GRU),保留时序 → 看"音素序列"而非频谱整体。

只在 stage-1 触发后对那一段复核,专门把 corona/ramona/monami 这类
"音素相近但序列不同"的词拒掉。~9万参数,端侧负担极小。
"""
from __future__ import annotations

import torch
import torch.nn as nn


class VerifierNet(nn.Module):
    def __init__(self, n_mels: int = 40):
        super().__init__()
        # 卷积只在频率维下采样,保留时间维(序列)
        self.conv = nn.Sequential(
            nn.Conv2d(1, 16, 3, padding=1), nn.GroupNorm(4, 16), nn.ReLU(),
            nn.MaxPool2d((2, 1)),  # freq/2, time 不变
            nn.Conv2d(16, 32, 3, padding=1), nn.GroupNorm(8, 32), nn.ReLU(),
            nn.MaxPool2d((2, 1)),  # freq/4
        )
        feat = 32 * (n_mels // 4)        # 每个时间步的特征维
        self.gru = nn.GRU(feat, 64, batch_first=True)
        self.fc = nn.Sequential(nn.Dropout(0.1), nn.Linear(64, 1))

    def forward(self, x):                # x: (B,1,n_mels,T)
        h = self.conv(x)                 # (B,32,n_mels/4,T)
        b, c, f, t = h.shape
        h = h.permute(0, 3, 1, 2).reshape(b, t, c * f)  # (B,T,feat) 时序
        out, _ = self.gru(h)             # (B,T,64)
        return self.fc(out[:, -1]).squeeze(1)  # 末状态 → logit
