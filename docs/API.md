# BehindVeil 接口契约说明（大白话版）

> 机器可读的正式契约在两份文件里：
>
> - `docs/openapi.yaml` —— **管理面 REST**（建房、房间、邀请码、会话、历史消息）
> - `docs/socketio-asyncapi.yaml` —— **房内实时事件**（进房、说话、开团、KP 预览）
>
> 本文只是给人看的导读，真正以那两份为准。

**最近更新：2026-10-01**（M8：5e 角色卡判别联合、damage/heal/sanity 指令、Host 转让/副 Host）

## 一句话：接口分成两条通道

| 通道 | 干什么 | 打个比方 |
|---|---|---|
| REST（HTTP 请求） | **开房间之前 / 房间之外**的事：建房、看房间列表、换邀请码、改设置、查会话、翻历史 | 像去前台办手续 |
| Socket.IO（长连接） | **进了房间之后**的事：进房、说话、开团、看 AI 怎么组装 prompt | 像进了包厢后大家一直在聊天 |

为什么分开：设计文档决议 D-03 定的。办手续用"问一句答一句"的 HTTP 就够了；聊天需要服务端随时推消息，只能用长连接。

## 现在到底能用什么

比上次好多了——**M1 已经落地，管理面这一组接口全都能跑**：

✅ 建房、房间列表、房间详情、重置邀请码、改房间设置
✅ 查房间的会话列表、结束会话、切换活跃会话
✅ 翻历史消息
✅ 房内：进房、说话（IC/OOC）、开团、KP 预览 prompt
✅ 卡库：上传 / 列出 / 删除角色卡（M5 前半）
✅ PC 声明：把玩家卡或速建表绑到成员，开团自动进状态板（M5）
✅ 模组：列出 / 装载 / 卸载模组包（M5 后半）
✅ 房内：状态板编辑（乐观锁）、生成快照、状态板广播（M5）
✅ PC 角色卡判别联合：COC7 / D&D 5e 两套字段体系，5e 速建表模板与状态板渲染（M8）
✅ AI 数值指令：`damage` / `heal` / `sanity` 服务端掷骰并自动写状态板（M8）
✅ Host 转让 / 副 Host：`POST /rooms/{id}/host-transfer`、`PUT /rooms/{id}/co-host`（M8）
✅ AI 叙事流 `narration:delta` / `narration:done`、`ai:invoke`（M3 已实装）

还没轮到的（按里程碑排队，不提前做）：

- 模组 zip 上传（multipart）—— 模组以目录形态放置，v1 用 `POST /modules { moduleId }` 校验装载

## 接口清单

### 管理面 REST（openapi.yaml）—— 全部 implemented

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/healthz` | 探活（唯一不用令牌的接口） |
| POST | `/rooms` | 建房，**响应里带一次性 hostToken** |
| GET | `/rooms` | 房间列表 |
| GET | `/rooms/{id}` | 房间详情 |
| POST | `/rooms/{id}/invite-reset` | 重置 6 位邀请码 |
| PATCH | `/rooms/{id}/settings` | 改房间名 / 人数上限 / 默认会话设置 |
| PATCH | `/rooms/{id}/sessions/{sid}/settings` | 改当前会话的运行时设置（温度 / 裁剪窗 / 世界书预算 / **nat20Rule**） |
| GET | `/rooms/{id}/sessions` | 这个房间跑过哪些场次（连载团） |
| GET | `/rooms/{id}/sessions/{sid}/export` | 导出这一场的跑团日志（`format=md` 缺省 / `html`） |
| POST | `/rooms/{id}/sessions/{sid}/end` | 结束某一场 |
| PUT | `/rooms/{id}/active-session` | 切换当前活跃场次（接着上一场跑） |
| GET | `/rooms/{id}/messages` | 翻历史消息（`beforeSeq` 向前翻页）—— **玩家端点，免令牌** |
| GET | `/rooms/{id}/pcs` | 列出 PC 声明（M5） |
| PUT | `/rooms/{id}/pcs/{memberId}` | 声明 / 覆盖 PC（cardId 或速建表 sheet 二选一，M5） |
| DELETE | `/rooms/{id}/pcs/{memberId}` | 撤销 PC 声明（M5） |
| GET | `/cards` | 卡库列表（摘要） |
| POST | `/cards` | 上传角色卡（PNG / JSON，走三步导入流） |
| GET | `/cards/{cardId}` | 取角色卡全文 |
| DELETE | `/cards/{cardId}` | 删除角色卡 |
| GET | `/modules` | 列出已装载模组（坏包跳过，M5） |
| POST | `/modules` | 装载模组：`{ moduleId }`（data/modules 下目录名），校验 manifest+三件套（M5） |
| DELETE | `/modules/{moduleId}` | 卸载模组；活跃会话引用中回 409 + E-MOD-01（D-09，M5） |
| POST | `/rooms/{id}/host-transfer` | Host 转让：`{ hostToken, toMemberId }`，旧 token 轮换失效（M8；鉴权用 hostToken，不用 X-Admin-Token） |
| PUT | `/rooms/{id}/co-host` | 设/撤副 Host：`{ hostToken, memberId \| null }`（M8；同上，hostToken 鉴权） |

模组以目录形态放置（`data/modules/<id>/` + manifest + 三件套），zip 上传不在此列。

### 玩家端点（免令牌，网页端在用）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/rooms/{id}/public` | 房间名 / 人数上限 / 当前活跃场次 —— **不含邀请码** |
| GET | `/rooms/{id}/messages` | 翻历史（暗骰与密语已被剔除） |
| GET | `/rooms/{id}/state` | 当前状态板（未开团为 `null`；之后靠 `state:broadcast` 增量维护，M5） |

为什么要单独拆出来：管理端点 `GET /rooms/{id}` 的响应**带邀请码**。如果把它和玩家端点
共用一把门禁，那么「设了 `AIDLE_ADMIN_TOKEN` → 网页端（不携带该头）进房就 401」，
而「不设 → 邀请码对所有人公开」。拆开之后两头都落得下：管理端点要令牌，
玩家端点免令牌但只给玩家该看的东西。

### 房内实时事件（socketio-asyncapi.yaml）

客户端 → 服务端：

| 事件 | 干什么 | 状态 |
|---|---|---|
| `room:join` | 用邀请码 + 昵称进房；带 hostToken 就是主持人；带 lastSeq 可补断线时漏掉的消息 | ✅ 可用 |
| `msg:send` | 发 IC（入戏）/ OOC（侧栏，可对主持人说或私聊某人） | ✅ 可用 |
| `session:start` | 主持人开团（选模组 + 设参数） | ✅ 可用 |
| `kp:previewPrompt` | 主持人查看这次请求到底组装了什么 prompt | ✅ 可用（M2） |
| `dice:roll` | 掷骰（`1d100<=60`、`3d6kh2`）；暗骰自己与主持人可见 | ✅ 可用（M4） |
| `state:update` | 改状态板（带乐观锁版本号，冲突回 E-ST-01 并广播最新版） | ✅ 可用（M5） |
| `state:snapshot` | 打一张状态快照钉在 prompt 里；每 20 条消息会提醒 KP | ✅ 可用（M5） |
| `ai:invoke` | 主动召唤 KP 说话（每人每轮 1 次） | ✅ 可用（M3） |

服务端 → 客户端：

| 事件 | 内容 | 状态 |
|---|---|---|
| `msg:broadcast` | 所有消息的统一出口（暗骰只发给主持人和掷骰的人） | ✅ 可用 |
| `kp:promptPreview` | prompt 组装全过程：token 数、命中了哪些世界书条目 | ✅ 可用（M2） |
| `error:app` | 业务错误码 | ✅ 可用 |
| `narration:delta` / `narration:done` | AI 讲故事的流式片段 / 讲完了 | ✅ 可用（M3） |
| `state:broadcast` | 状态板变了（含乐观锁冲突后的最新版对齐） | ✅ 可用（M5） |

## 上次那四个待拍板的问题，已经定了

1. **主持人身份怎么认** → 建房时**一次性下发 `hostToken`**，进房时带上它就被认定为主持人。这个令牌只在建房那一次响应里出现，之后再也要不到（丢了只能重建房间）。主持人断线重连同样得出示，防止别人冒领。
2. **管理面要不要鉴权** → 设环境变量 `AIDLE_ADMIN_TOKEN` 后，管理类接口都要带 `X-Admin-Token` 头；**不设就全部放行**（零配置，靠网络边界保护），启动日志会打一条告警提醒。
   **2026-09-26 修订**：原方案里「网页端一旦设置就进房失败」是缺陷，已按代码审查做**路由分离**——玩家端点（`GET /rooms/{id}/public`、`GET /rooms/{id}/messages`）免令牌，管理端点才要令牌。现在这个开关既能给浏览器用，也能给运维脚本用。
3. **模组卸载冲突** → 新增错误码 `E-MOD-01`「模组使用中，无法卸载」。
4. **历史消息走哪条路** → 走 REST `GET /rooms/{id}/messages`；Socket 只负责补断线期间漏掉的那几段。

顺带还新增了一个错误码 `E-SRV-01`「服务器开小差了，请稍后重试」——写盘失败时用，那条消息不会广播出去（落盘失败就不算数）。

## 三个 curl 示例（这些现在真能跑）

```bash
# 1. 探活
curl http://127.0.0.1:8787/healthz
# {"ok":true,"name":"BehindVeil-server","protocol":"0.0.0"}

# 2. 建房（记下 hostToken，只出现这一次）
curl -X POST http://127.0.0.1:8787/rooms \
  -H 'content-type: application/json' \
  -d '{"name":"疯狂山脉·第一夜","memberLimit":6}'
# 201 → {"id":"V1StGXR8_Z5j","name":"疯狂山脉·第一夜","inviteCode":"A7K2Q9",
#        "activeSessionId":null,"memberLimit":6,
#        "createdAt":"2026-09-25T10:15:30.000Z","hostToken":"ht_9f2c1a7b3e5d"}

# 3. 翻历史消息（最新 50 条，降序）
curl 'http://127.0.0.1:8787/rooms/V1StGXR8_Z5j/messages?limit=50'

# 4. 结束当前这一场
curl -X POST http://127.0.0.1:8787/rooms/V1StGXR8_Z5j/sessions/s_01J9Z8Y7X6/end
```

## 几个容易踩的坑

- **历史消息是倒序的**（最新在前），跟断线补发的顺序相反，前端要自己反转一下。
- **暗骰不进历史**：隐藏骰子 `/messages` 一律不返回（防泄露），只能从实时流里看——断线补发同样不给旁人补暗骰（`lastSeq` 是客户端给的，服务端按身份过滤）。
- **每颗骰子都有审计号**：服务端先写 `data/logs/audit-dice.jsonl`（fsync）再广播，所以「已广播的骰子一定有流水号」。想验算就跑一下复现校验器（见下文）。
- **发送限速** 10 条 / 30 秒 / 人，超了回"发送太频繁"。
- **非法 payload 会被直接断连**，而不是回个错误码——这是防伪造事件的设计，调试时别以为是 bug。
- **结束会话后房内不能发言**，得重新开团或把活跃会话切回旧场次。

## 掷骰这条线是怎么保证「不作弊」的

玩家在输入框敲 `.r 1d100<=60`（暗骰敲 `.rh 1d100`），发生的事只有服务端说了算：

1. 前端只把骰式原样发上来，自己不算数；
2. 服务端用 CSPRNG 掷骰，**先**把「骰式 + 原始骰值 + 结果」写进 `data/logs/audit-dice.jsonl`（落盘后才继续），**再**广播给大家；
3. 每条消息里都带审计流水号（`#000123`），同一次掷骰所有人看到的号一致；
4. 事后可以拿流水验算：`node packages/server/dist/tools/audit-replay.js [文件路径]`
   会按「表达式 + 原始骰值」把每一条重算一遍，对不上就报出来（退出码 1）。

注意验算的是「算得对不对」，不是「能不能再摇出一模一样的点数」——CSPRNG 没有种子，本来就不该能重摇。

## 规则书：一房一套（COC7 / D&D 5e）

- 规则书由**开团时选的模组**决定（KP 卡的 `extensions.aidle.rulebook` 优先，没有就用模组 manifest 里写的），写进会话的 `rulebook` 字段。缺省 `coc7`，老数据不受影响。
- **一房一规则书**：房里已经有活跃会话时，换一套规则书的模组开团会被拒绝（`E-MOD-01`），活跃会话保持不变。换同规则书的模组不受影响（连载团照常复播）。
- 判定差别：COC7 是 `1d100<=技能值` 六档判定表；5e 是 `1d20+修正>=DC`（攻击目标写成 AC），并按会话设置 `nat20Rule` 判 nat20 必中 / nat1 必失——**判的是 d20 面值**，加了修正到 25 不算 nat20。
  `nat20Rule` 默认 `attack_only`（官方口径，只有攻击骰算），KP 控制台可切 `all_d20`（桌面房规）。
- 优劣势：骰式末尾写 `adv` / `dis`（如 `.r 1d20+5>=13 adv`），服务端展开成 `2d20kh1` / `2d20kl1` 再掷，流水里记的就是展开后的骰式。

## 角色卡：一套契约两种规则书（M8）

- `PCSheet` 是按 `rulebook` 字段的判别联合：COC7 卡（str…san/skills）与 5e 卡（六维 abilities / 熟练加值 / AC / HP max+current / 熟练技能与豁免）。**旧数据不用迁移**：没有 `rulebook` 字段的存量卡和 state.json 一律按 coc7 解析。
- 技能取值永远服务端现算：COC7 查 `skills[名]`；5e = `floor((属性−10)/2) + (熟练 ? 熟练加值 : 0)`，AI 和客户端都只传名字不传数值。中文/英文技能名都认（「察觉」= perception）。
- 卡库面板有 COC7 / D&D 5e 两份速建表模板，粘贴 JSON 改数值即可声明。

## AI 数值指令：伤害 / 治疗 / 理智（M8）

KP 的 AI 在 ```aidle 指令块里除了 `check` 还可以请求三种数值效果，面值全部由服务端掷骰：

```jsonc
{ "op": "damage", "target": "pc:alice", "expr": "1d8+2", "label": "哥布林弯刀" }
{ "op": "heal",   "target": "pc:alice", "expr": "2d4+2" }
{ "op": "sanity", "target": "pc:alice", "loss": "1d6" }   // loss 缺省查 COC7 房规损失表
```

处理链统一是：strictObject 校验（夹带 `result`/`total`/`hp` 等数值字段直接拒绝，E-AI-01）→ 服务端 CSPRNG 掷骰（先落审计流水）→ 骰子卡广播 → 引擎写状态板（HP/SAN clamp 到合法区间）→ `state:broadcast`。规则书防呆：COC 卡收到 damage/heal、5e 卡收到 sanity 都会被拒（E-AI-01），不掷骰。

## Host 转让 / 副 Host（M8）

- **转让**：`POST /rooms/{id}/host-transfer`，当前 Host 出示 hostToken 指定一名**在线**成员。转让后 members.json 角色换位、hostToken 立即轮换（旧的作废）、房间 `hostAuth` 标为 `member`——新 Host 以后凭成员身份（memberId）重连即可，不需要 token。原 Host 即刻降为玩家。
- **副 Host**：`PUT /rooms/{id}/co-host` 指定一名在线成员（`memberId: null` 撤销）。副 Host 与 Host 同享**快照 + 状态编辑**权限，Host 掉线也能代行；不发新 token。
- 未转让的房间维持 v1 口径：Host 重连必须出示 hostToken，防 memberId 冒领。

## 怎么读这两份文件

不用装任何东西，挑一个顺手的：

1. 打开 <https://editor.swagger.io>，把 YAML 贴进去，右侧出可交互文档（AsyncAPI 用 <https://studio.asyncapi.com>）。
2. VS Code 装 `OpenAPI (Swagger) Editor` 或 `42Crunch` 插件，本地打开即有补全和校验。
3. 命令行：`npx @redocly/cli lint docs/openapi.yaml`。
