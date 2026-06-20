"""Loona KWS 网络结构(训练与推理共用)。需要 torch。"""

from __future__ import annotations

import torch.nn as nn


class KWSNet(nn.Module):
    """端侧 KWS 网络。输入 (B,1,n_mels,T) → logit。

    加大版(~180k 参数):提升对近似音的判别力,仍适合端侧。
    可用 LOONA_KWS_SMALL=1 切回早期 ~23k 小模型(消融对比)。
    """

    def __init__(self, n_mels: int = 40):
        super().__init__()
        import os
        if os.environ.get("LOONA_KWS_SMALL"):
            self.net = nn.Sequential(
                nn.Conv2d(1, 16, 3, padding=1), nn.BatchNorm2d(16), nn.ReLU(), nn.MaxPool2d(2),
                nn.Conv2d(16, 32, 3, padding=1), nn.BatchNorm2d(32), nn.ReLU(), nn.MaxPool2d(2),
                nn.Conv2d(32, 64, 3, padding=1), nn.BatchNorm2d(64), nn.ReLU(),
                nn.AdaptiveAvgPool2d(1),
            )
            self.fc = nn.Linear(64, 1)
        else:
            # 用 GroupNorm 替代 BatchNorm:无训练/推理统计量不一致问题(深层更稳)
            self.net = nn.Sequential(
                nn.Conv2d(1, 32, 3, padding=1), nn.GroupNorm(8, 32), nn.ReLU(), nn.MaxPool2d(2),
                nn.Conv2d(32, 64, 3, padding=1), nn.GroupNorm(8, 64), nn.ReLU(), nn.MaxPool2d(2),
                nn.Conv2d(64, 96, 3, padding=1), nn.GroupNorm(8, 96), nn.ReLU(), nn.MaxPool2d(2),
                nn.Conv2d(96, 128, 3, padding=1), nn.GroupNorm(8, 128), nn.ReLU(),
                nn.AdaptiveAvgPool2d(1),
            )
            self.fc = nn.Sequential(nn.Dropout(0.1), nn.Linear(128, 1))

    def forward(self, x):
        return self.fc(self.net(x).flatten(1)).squeeze(1)
