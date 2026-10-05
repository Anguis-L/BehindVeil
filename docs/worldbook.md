# 世界书指南（v1 手编 + v3 可视化编辑器，决议 D-08）

> v3 更新（M11）：可视化编辑器已落地（KP 控制台「世界书」标签，Host 可见），
> 手编依然完全可用——两条路径共用同一份文件与同一套校验。本文前半部分讲字段与
> 校验口径（两条路径通用），末尾一节讲编辑器的行为边界。

v1 **不做可视化编辑器**：世界书以 JSON 文件手编，服务端载入时校验（防范围蔓延，可视化编辑器留二期）——该限制已于 v3 M11 解除。

## 文件位置

```
data/rooms/<roomId>/worldbook.json
```

房间级世界书，对该房所有会话生效。M5 模组包落地后，模组自带的世界书（`modules/<id>/worldbook.json`）与房间级文件并存：模组层**只读**，要改就复制到房间层再编辑（见末尾「可视化编辑器」一节）。

## 载入行为

- 文件不存在：空世界书（手编可选，不报错）。
- JSON 语法错误或结构校验未通过：**载入拒绝并抛错**（错误信息带 `uid=` 定位）。
- 语义隐患（见下）：告警放行，不阻塞载入。
- 落盘形态（v3 M11 起）：`{ "schemaVersion": 1, "entries": [...] }`。编辑器保存带版本信封，
  收编进迁移管辖；**手编的裸 `{ "entries": [...] }` 照样读得进**，不强制先跑 `pnpm aidle-migrate`。

## 字段说明（`WorldBookEntry`，TDD §3.4）

| 字段 | 类型 | 说明 |
|---|---|---|
| `uid` | number | 条目唯一 ID（trace 定位与递归去重的键，**不得重复**） |
| `key` | string[] | 主关键词，任一命中即 primary 命中；支持 `/regex/` 形式 |
| `keysecondary` | string[] | 二级关键词（可空） |
| `selectiveLogic` | 0/1/2/3 | 0=AND_ANY 1=NOT_ALL 2=NOT_ANY 3=AND_ALL（配合 `keysecondary`） |
| `content` | string | 注入 prompt 的条目文本 |
| `position` | string | `before_char`（system 骨架前）/ `after_char`（system 骨架后）/ `at_depth`（按深度插入对话历史） |
| `depth` | number? | `position=at_depth` 时**必填**：距对话底部的消息条数（0 = 最末） |
| `order` | number | 同权重内排序（小者在前） |
| `weight` | number | 默认 100；世界书预算不足时高权重优先保留 |
| `constant` | boolean | true = 常驻注入（无视关键词） |
| `disabled` | boolean | true = 永不参与扫描 |
| `extensions.kpOnly` | boolean? | 模组真相条目：恒注入 prompt，但仅 Host 的预览可见（TC-FR-07-012） |

## 匹配语义

1. 扫描文本 = 最近 `scanDepth` 条消息（会话设置）拼接。
2. `constant=true` 或 `extensions.kpOnly=true`：恒命中。
3. `keysecondary` 为空：primary 命中即命中。
4. 四种 `selectiveLogic` 以 secondary 的命中集合判定（见上表）。
5. 递归 1 层：命中条目的 `content` 并入扫描文本再扫一轮；已命中条目不重复计（防循环）。
6. `/regex/` 形式的关键词按正则匹配；**非法正则降级为字面量子串**并打告警日志（不崩溃）。
7. 子串与正则匹配均大小写敏感（确定性优先，黄金用例依赖）。

## 告警项（载入放行，建议修正）

- 非常驻且非 kpOnly 的条目 `key` 为空 → 永远不会命中。
- 非法正则（如 `/bad(/`）→ 运行时降级为字面量。

## 最小示例

```json
{
  "entries": [
    {
      "uid": 1,
      "key": ["书房", "书桌"],
      "keysecondary": [],
      "selectiveLogic": 0,
      "content": "书房的壁炉后有一条暗道，只有移动书桌才能发现。",
      "position": "after_char",
      "order": 0,
      "weight": 100,
      "constant": false,
      "disabled": false
    },
    {
      "uid": 2,
      "key": [],
      "keysecondary": [],
      "selectiveLogic": 0,
      "content": "（KP 专用）暗道尽头是仪式室，玩家尚未发现。",
      "position": "after_char",
      "order": 1,
      "weight": 100,
      "constant": true,
      "disabled": false,
      "extensions": { "kpOnly": true }
    }
  ]
}
```

> `depth` 仅 `position=at_depth` 时需要（非负整数）；其余位置省略即可。

> `depth` 仅 `position=at_depth` 时需要（非负整数）；其余位置省略即可。
> v3 起编辑器写出的文件会在最外层多一个 `"schemaVersion": 1` 字段，手编时不必补——缺了按旧版读取。

## 可视化编辑器（v3 M11，FR-35）

KP 控制台右栏新增「世界书」标签（仅 Host 可见），不必再手编 JSON：

- **列表**：>500 条自动转虚拟滚动（只渲染视口内的行），大世界书不会拖慢房间页。
- **编辑**：选中条目改字段，改动先落在列表里，**点「保存」才写盘**——保存是全量替换
  （不是增量 patch），走 `PUT /rooms/{roomId}/worldbook`。
- **校验**：与手编载入同一套判据。结构错误（uid 重复、`at_depth` 缺 depth）→ 拒绝保存
  并给出定位，**磁盘上的旧文件分毫不动**；语义隐患（空关键词、非法正则）→ 保存成功但
  界面列出告警。
- **模组层只读**：输入模组 ID 可读出模组世界书条目，点「复制到房间」把它们并入房间
  （uid 自动重排，内容重复的不会重复复制）。模组包本身改不了——那是外部资产。

手编与编辑器可以随时交替使用：编辑器读的是同一个文件，手编改完点「重新读取」即可。
