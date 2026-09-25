# BehindVeil 接口契约说明（大白话版）

> 机器可读的正式契约在两份文件里：
>
> - `docs/openapi.yaml` —— **管理面 REST**（建房、房间列表、邀请码、卡库、模组）
> - `docs/socketio-asyncapi.yaml` —— **房内实时事件**（说话、掷骰、AI 叙事、状态板）
>
> 本文只是给人看的导读，真正以那两份为准。

## 一句话：接口分成两条通道

| 通道 | 干什么 | 打个比方 |
|---|---|---|
| REST（HTTP 请求） | **开房间之前 / 房间之外**的事：建房、看房间列表、换邀请码、改房间设置、管角色卡和模组 | 像去前台办手续 |
| Socket.IO（长连接） | **进了房间之后**的事：说话、掷骰、看 AI 讲故事、状态板变化 | 像进了包厢后大家一直在聊天 |

为什么分开：设计文档决议 D-03 定的。办手续用"问一句答一句"的 HTTP 就够了；聊天需要服务端随时推消息，只能用长连接。

## 现在到底能用什么

**M0 + M1 管理面已经实现**（2026-09-25）：

- ✅ `GET /healthz` —— 探活
- ✅ 建房 / 房间列表 / 房间详情 / 邀请码重置 / 房间配置 / 会话列表 / 历史消息 / 会话结束与切换
- ✅ Socket：`room:join`（含断线补发）、`session:start`、`msg:send`（限速 + OOC 路由）

M5 的卡库 / 模组管理仍是**契约先行、代码未写**（按 M0→M6 推进，不提前实现）。

## 接口清单与状态

标注含义：`implemented` = 已实现（有测试背书） · `planned` = 设计文档已定好要做 · `proposed` = 提案。管理面鉴权（决议 ②）：设了环境变量 `AIDLE_ADMIN_TOKEN` 后，除 `/healthz` 外都要带 `X-Admin-Token` 头；不设则零配置开放。

### 管理面 REST（openapi.yaml）

| 方法 | 路径 | 作用 | 状态 | 里程碑 |
|---|---|---|---|---|
| GET | `/healthz` | 健康检查 | implemented | M0 |
| POST | `/rooms` | 建房（响应带 hostToken，决议 ①） | implemented | M1 |
| GET | `/rooms` | 房间列表 | implemented | M1 |
| POST | `/rooms/{id}/invite-reset` | 重置 6 位邀请码 | implemented | M1 |
| PATCH | `/rooms/{id}/settings` | 改房间名 / 人数上限 / 默认会话设置 | implemented | M1 |
| GET | `/rooms/{id}` | 查单个房间 | implemented | M1 |
| GET | `/rooms/{id}/sessions` | 这个房间跑过哪些场次（连载团） | implemented | M1 |
| POST | `/rooms/{id}/sessions/{sid}/end` | 结束会话（提案回补） | implemented | M1 |
| PUT | `/rooms/{id}/active-session` | 切换活跃会话（连载复播，提案回补） | implemented | M1 |
| GET | `/rooms/{id}/messages` | 翻历史消息（beforeSeq 向前翻页，决议 ④） | implemented | M1 |
| GET/POST/DELETE | `/cards`、`/cards/{id}` | 角色卡导入 / 列表 / 删除 | proposed | M5 |
| GET/POST/DELETE | `/modules`、`/modules/{id}` | 模组包加载 / 卸载 | proposed | M5 |

### 房内实时事件（socketio-asyncapi.yaml）

客户端 → 服务端：

| 事件 | 干什么 | 权限 |
|---|---|---|
| `room:join` | 用邀请码 + 昵称进房 | 公开 |
| `session:start` | 选模组、开一场 | Host |
| `msg:send` | 发 IC（入戏）/ OOC（侧栏） | player+ |
| `ai:invoke` | 主动召唤 KP 说话（每人每轮 1 次） | player+ |
| `dice:roll` | 掷骰（`1d100<=60`、`3d6kh2`） | player/host；暗骰仅 Host |
| `state:update` | 改状态板（带乐观锁版本号） | Host/引擎 |
| `state:snapshot` | 打一张状态快照钉在 prompt 里 | Host |
| `kp:previewPrompt` | 看这次请求到底组装了什么 prompt | Host |

服务端 → 客户端：

| 事件 | 内容 |
|---|---|
| `msg:broadcast` | 六类消息统一出口（暗骰只发 Host） |
| `narration:delta` / `narration:done` | AI 讲故事的流式片段 / 讲完了 |
| `state:broadcast` | 状态板变了 |
| `kp:promptPreview` | prompt 组装全过程（token 数、命中了哪些世界书条目） |
| `error:app` | 业务错误码 |

## 怎么读这两份文件

不用装任何东西，挑一个顺手的：

1. 打开 <https://editor.swagger.io>（或 Redoc 在线版），把 YAML 贴进去，右侧直接出可交互文档。
2. VS Code 装 `OpenAPI (Swagger) Editor` 或 `42Crunch` 插件，本地打开即有补全和校验。
3. 命令行：`npx @redocly/cli lint docs/openapi.yaml` 做规范校验。

## 几个 curl 示例（服务端已实现，可以直接跑）

```bash
# 1. 探活（永远公开）
curl http://127.0.0.1:8787/healthz
# {"ok":true,"name":"BehindVeil-server","protocol":"0.0.0"}

# 2. 建房：响应多一个 hostToken（决议 ①），进房时出示它就是 Host
curl -X POST http://127.0.0.1:8787/rooms   -H 'content-type: application/json'   -d '{"name":"疯狂山脉·第一夜","memberLimit":6}'
# 201 → {"id":"V1StGXR8_Z5j","inviteCode":"A7K2Q9","hostToken":"9wZ...",
#        "activeSessionId":null,"memberLimit":6,...}

# 3. 重置邀请码
curl -X POST http://127.0.0.1:8787/rooms/V1StGXR8_Z5j/invite-reset
# 200 → {"inviteCode":"9ZP4RT"}

# 4. 若服务端设了 AIDLE_ADMIN_TOKEN，管理接口要带令牌（决议 ②），否则 401
curl -H 'X-Admin-Token: <令牌>' http://127.0.0.1:8787/rooms

# 5. 历史消息（决议 ④：走 REST，seq 最新在前）
curl "http://127.0.0.1:8787/rooms/V1StGXR8_Z5j/messages?limit=50"
```

## 之前的四个开放问题——已拍板（2026-09-25），两份 spec 已回写

1. **建房者怎么证明自己是 Host？** → 决议 ①：建房响应携带 `hostToken`，进房（`room:join`）时出示即成为 Host；凭据只随建房响应发放一次，其余接口一律不回带。
2. **REST 管理面要不要鉴权？** → 决议 ②：环境变量 `AIDLE_ADMIN_TOKEN` 设置后启用门禁（`X-Admin-Token` 头，缺失/错误 401，`/healthz` 永远公开）；不设则零配置开放，仍建议只在内网/反代后暴露。
3. **模组卸载冲突用什么错误码？** → 决议 ③：新增 `E-MOD-01`（错误码表第 7 码），已入 `shared/errors.ts` 与 openapi 错误模型，M5 模组卸载消费。
4. **历史消息走 REST 还是 Socket？** → 决议 ④：走 REST（`GET /rooms/{id}/messages`）；Socket 的 `lastSeq` 补发只负责断线重连的缺口，两者互补。

公网部署提醒不变：管理面令牌是唯一一道门，仍建议反代 + TLS + 内网/白名单（SDD R-06）。
