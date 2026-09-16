# 战斗数据文件结构

## 设计目标

战斗数据按照依赖范围分层保存。基础类型不携带实际玩法效果，地图不携带单位或胜负规则，规则通过稳定 ID 引用基础类型。每场战斗由独立入口文件明确列出使用的全部资源。

经典模式没有仅适用于本场战斗的特殊规则。`battles/classic/battle.json` 因此将 `scenarioRules` 设置为 `null`，现有规则全部位于可复用的战斗规则和通用游戏规则中。突围战斗复用经典地形、单位、战斗规则和通用游戏规则，通过自己的特殊规则绑定部署区域、目标区域和兵力配置。

## 目录

```text
data/
├── terrain-types/
│   └── classic-terrain.json
├── unit-types/
│   └── classic-units.json
├── maps/
│   ├── classic-six-rows.json
│   └── breakout.json
├── combat-rules/
│   └── classic-combat.json
├── game-rules/
│   └── classic-game.json
├── ai-profiles/
│   └── light-search.json
├── battles/
│   ├── classic/
│   │   └── battle.json
│   └── breakout/
│       ├── battle.json
│       └── scenario-rules.json
└── battle-catalog.json
```

## 分层与依赖

```text
battle-catalog.json
└──→ battle.json
     ├──→ terrain-types
     ├──→ unit-types
     ├──→ maps ───────────────→ terrain-types
     ├──→ combat-rules
     │    ├──→ terrain-types
     │    └──→ unit-types
     ├──→ game-rules ─────────→ combat-rules
     ├──→ ai-profiles
     │    ├──→ terrain-types
     │    └──→ unit-types
     └──→ scenario-rules
          ├──→ terrain-types
          ├──→ unit-types
          ├──→ maps
          ├──→ combat-rules
          └──→ game-rules
```

`A → B` 表示 A 依赖 B。具体依赖如下：

| 文件层 | 直接依赖 | 职责 |
|---|---|---|
| `terrain-types` | 无 | 地形身份和显示信息 |
| `unit-types` | 无 | 单位身份和显示信息 |
| `maps` | `terrain-types` | 格子、地形排列、连接和绘制布局 |
| `combat-rules` | `terrain-types`、`unit-types` | 移动、攻击、伤害及地形和单位交互 |
| `game-rules` | `combat-rules` | 部署、回合、胜负和完整对局流程 |
| `ai-profiles` | `terrain-types`、`unit-types` | 可跨战斗复用的机器人算法、估值、搜索预算、难度和执行限制 |
| `scenario-rules` | 以上全部 | 仅适用于一场具体战斗的规则和地图绑定 |
| `battle.json` | 以上资源 | 声明一场战斗使用的确定资源和版本 |
| `battle-catalog.json` | `battle.json` | 声明服务器提供哪些战斗 |

## 基础类型

`terrain-types` 只保存地形 ID、名称、颜色、边框、符号、图标和描述。不得保存通行、免疫、移动消耗或攻击效果。

`unit-types` 只保存单位 ID、名称、简称、图标和描述。不得保存移动力、射程、伤害、免疫、阵营限制或部署上限。

这种分离允许同一个单位或地形在不同规则集中具有不同效果。

## 地图

地图通过 `terrainTypeSet` 声明使用的地形类型集。每个格子只引用一个地形 ID。地图保存格子坐标、显式连接关系、尺寸和绘制布局，不保存地形效果、单位规则、部署规则或胜利条件。

连接关系必须直接序列化在地图的 `connections` 字段中。地图制作工具可以根据相邻坐标生成连接表，但服务器运行时只读取、去重和校验连接，不会根据格子坐标动态推导。这样地图连接可视、可审查，规则不会因算法版本变化而改变。

突围地图的 55 个地块和 100 条无向边均显式写入 `maps/breakout.json`。原图第 9、10 列位于主行之间，因此使用 `5.5`、`6.5`、`7.5`、`8.5` 四个逻辑行 ID，而不是整数行上的显示偏移。半行第 9 列分别连接上下主行的第 8 列，例如界面坐标 `(5.5,9)` 同时连接 `(5,8)` 和 `(6,8)`。占位符 `0` 不生成地块或连接。

地图文件本身不再保存 `deploymentRows`。经典模式的部署行属于通用游戏规则，服务器装配战斗时将其加入运行时棋盘描述，从而保持原有网络状态和玩法行为。

## 战斗规则

`combat-rules` 只基于确定的地形类型集和单位类型集。经典战斗规则包含：

- `unitProfiles`：移动、射程、行动限制和单位免疫。
- `terrainProfiles`：可通行单位、攻击免疫和特殊进入方式。
- `combat`：击毁所需命中次数及直接击毁关系。

反坦克炮直接击毁机枪车及堡垒内目标的规则位于 `combat-rules/classic-combat.json` 的 `combat.instantKill`。

## 通用游戏规则

`game-rules` 通过 `requires.combatRules` 绑定一套战斗规则。在战斗规则之上定义：

- 各阵营允许部署的单位和数量上限。
- 部署区域、默认增援和行动后部署选项。
- 轮流回合和同时回合流程。
- 胜利条件和结束原因文本。

当前经典模式的这些规则均可复用，没有拆出特殊规则。

## 特殊规则

特殊规则预留在 `battle.json` 的 `resources.scenarioRules` 中。它用于未来确实只属于一场战斗的初始摆放、地图区域绑定、剧情事件、规则替换或额外胜利条件。

经典模式的值为 `null`。突围模式的特殊规则只使用当前白名单能力：地图区域、双方部署区、兵种阵营与数量限制、默认增援和进攻目标区域。突围地图中编号 `6` 对应的格子同时属于防守方部署区和进攻方目标区，两个区域在序列化数据中显式包含这些相同坐标。特殊规则中的资源依赖、区域坐标和单位 ID 均在启动时校验。

## 人机配置

`ai-profiles` 不绑定战斗 ID 或地图 ID。它依赖可复用的地形类型和单位类型，并保存单位估值、地形估值、胜利目标威胁估值、难度与搜索限制。战斗入口通过资源引用选择机器人配置，因此多个战斗可以显式共享同一算法。当前经典模式和突围都引用 `ai-profiles/light-search.json`。

`light-search` 使用最多两层的有界前瞻搜索。每个难度分别限制根候选数、后续分支数、总节点数和单次搜索时间；服务器达到任一上限就立即使用当前最佳结果。当前上限为 8 至 48 个节点和 3 至 12 毫秒，适用于低性能服务器。机器人只搜索服务端规则引擎生成的合法行动，不从地图行号推导移动或部署规则，因此可处理经典棋盘和突围的不规则连接、部署区域及目标区域。

## 战斗入口

`battles/<battle-id>/battle.json` 是单场战斗入口。它保存战斗名称、引擎、功能能力和资源引用，包括可选的特殊规则和启用人机时必需的 AI 配置。每个资源引用包含：

```json
{
  "path": "combat-rules/classic-combat.json",
  "id": "classic-combat",
  "contentVersion": 1
}
```

`path` 必须位于 `data` 目录内；`id` 和 `contentVersion` 必须与目标文件一致。当前经典入口明确引用地形类型、单位类型、地图、战斗规则和通用游戏规则，并将特殊规则设置为 `null`。

## 总入口

`battle-catalog.json` 是服务器的唯一数据入口。它只登记战斗 ID、战斗入口路径、版本和启用状态。大厅中的模式列表由成功加载的战斗入口生成。

## 加载和校验

服务器按以下顺序装配战斗：

1. 读取 `battle-catalog.json`。
2. 读取对应的 `battle.json`。
3. 加载地形类型和单位类型。
4. 加载并校验战斗规则的类型依赖。
5. 加载并校验通用游戏规则的战斗规则依赖。
6. 加载并校验战斗入口引用的通用 AI 配置。
7. 加载地图并检查每个格子的地形 ID。
8. 检查资源 ID、内容版本、未知单位、未知地形和路径越界。
9. 将分层文件装配成现有服务器使用的只读运行时定义。

单个无效战斗会被跳过并记录错误。经典战斗是必需资源；经典战斗无法加载时服务器拒绝启动。服务器不会用默认规则悄悄替代损坏或不兼容的数据。

## 版本约定

每个定义文件使用两个版本字段：

- `schemaVersion`：文件格式版本。
- `contentVersion`：规则或内容版本。

战斗入口固定引用 `contentVersion`。修改既有内容时应提升内容版本并同步更新入口，避免存档、回放或客户端错误地使用不同版本的定义。

资源 ID 使用稳定的 ASCII 标识，例如 `classic-terrain`、`antiTank` 和 `classic-combat`。显示名称可以修改，已被其他文件引用的 ID 不应直接改名。

## 运行时兼容

磁盘文件完成分层后，服务端仍会生成与重构前等价的 `board`、`units` 和 `rules` 对象。前端继续从服务器接收完整定义和合法行动结果，不需要理解磁盘目录结构，也不自行计算规则。

旧的 `variantId` 网络字段暂时保留，值仍为 `classic`，用于兼容现有房间协议和前端代码。磁盘入口已经改由 `battle-catalog.json` 和 `battle.json` 管理。
