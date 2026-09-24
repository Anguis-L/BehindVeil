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

坦白说：**只有一个接口是真的**。

- ✅ `GET /healthz` —— 探活，返回 `{"ok":true,"name":"BehindVeil-server","protocol":"0.0.0"}`

其余全部是**先把契约写死、代码还没写**（项目在 M0 里程碑，按 M0→M6 推进，不提前实现）。
这么做是为了让前端能照着契约并行开发，不用等服务端。

## 接口清单与状态

标注含义：`implemented` = 已实现 · `planned` = 设计文档已定好要做 · `proposed` = 文档只说了"走 REST"，路径和字段是我补全的提案，**待你拍板**。

### 管理面 REST（openapi.yaml）

| 方法 | 路径 | 作用 | 状态 | 里程碑 |
|---|---|---|---|---|
| GET | `/healthz` | 健康检查 | implemented | M0 |
| POST | `/rooms` | 建房（建房者即 Host） | planned | M1 |
| GET | `/rooms` | 房间列表 | planned | M1 |
| POST | `/rooms/{id}/invite-reset` | 重置 6 位邀请码 | planned | M1 |
| PATCH | `/rooms/{id}/settings` | 改房间名 / 人数上限 / 默认会话设置 | planned | M1 |
| GET | `/rooms/{id}` | 查单个房间 | proposed | M1 |
| GET | `/rooms/{id}/sessions` | 这个房间跑过哪些场次（连载团） | proposed | M1 |
| GET | `/rooms/{id}/messages` | 翻历史消息（beforeSeq 向前翻页） | proposed | M1 |
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

## 三个 curl 示例（照着契约写的，跑不通属于正常——服务端还没实现）

```bash
# 1. 探活（这个现在就能跑）
curl http://127.0.0.1:8787/healthz
# {"ok":true,"name":"BehindVeil-server","protocol":"0.0.0"}

# 2. 建房
curl -X POST http://127.0.0.1:8787/rooms \
  -H 'content-type: application/json' \
  -d '{"name":"疯狂山脉·第一夜","memberLimit":6}'
# 201 → {"id":"V1StGXR8_Z5j","name":"疯狂山脉·第一夜","inviteCode":"A7K2Q9",
#        "activeSessionId":null,"memberLimit":6,"createdAt":"2026-09-25T10:15:30.000Z"}

# 3. 重置邀请码
curl -X POST http://127.0.0.1:8787/rooms/V1StGXR8_Z5j/invite-reset
# 200 → {"inviteCode":"9ZP4RT"}
```

## 落到 M1 之前，有几个问题得先拍板

这几条设计文档**没有定义**，我在 spec 里按最合理的假设写了，但你得确认：

1. **建房者怎么证明自己是 Host？** 建房走 REST（没有身份），进房走 Socket（靠邀请码），中间缺一根线把它们连起来。现在假设"建房响应返回的东西能在握手时证明 Host 身份"，但字段没定。
2. **REST 管理面要不要鉴权？** 现在的假设是"自托管单机，靠网络边界保护"（只听 127.0.0.1 或反代 + TLS + IP 白名单）。如果你打算把管理面暴露到公网，得加令牌。
3. **模组卸载冲突用什么错误码？** 决议 D-09 说"有活跃会话引用就拒绝卸载"，但错误码表里没有对应的码，我暂用 409 + `E-ROOM-01`，建议新增 `E-MOD-01`。
4. **历史消息走 REST 还是 Socket？** 施工文档 T-M1-09 写的是"`gateway/http/` 或 socket 事件"，通道没定，我暂按 REST 提案。

拍板后告诉我，我回写这两份文件。
