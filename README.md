# HOMG0 局域网联机 Demo

端口：37788

## 可选音效

音效目录位于 `public/audio/`。没有对应文件则不播放；同一目录有多个支持格式的文件时随机选择。

支持：`.mp3` `.wav` `.ogg` `.m4a` `.aac` `.webm` `.flac`

```text
public/audio/
├── bgm/                         # 背景音乐，可放多个文件
├── move/
│   ├── infantry/                # 步兵移动
│   ├── anti-tank/               # 反坦克炮移动
│   └── machine-gun/             # 机枪车移动
├── attack/
│   ├── infantry/                # 步兵攻击
│   ├── anti-tank/               # 反坦克炮攻击
│   └── machine-gun/             # 机枪车攻击
└── death/
    ├── infantry/                # 步兵死亡
    ├── anti-tank/               # 反坦克炮死亡
    └── machine-gun/             # 机枪车死亡
```

浏览器通常禁止未经过用户操作的自动播放，因此背景音乐会在玩家第一次点击、触摸或按键后开始。
