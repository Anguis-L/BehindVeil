# 部署与运维

> 追溯：NFR-02（数据主权）、NFR-07（可移植）、R-06（公网部署被扫描/滥用）。
> 适用版本：v1（v3 增补热备与存档版本门禁，见 §3.1/§4.1 与 [backup.md](./backup.md)）。本文是**唯一**的部署口径来源，README 只保留链接。

## 1. 部署形态

单个 Node.js 进程，没有数据库、没有 Redis、没有消息队列。

- 进程内完成：HTTP（Fastify）+ WebSocket（Socket.IO）+ 领域逻辑 + 文件存储。
- 所有状态落 `data/` 目录：**备份 = 复制这个目录，迁移 = 拷走这个目录，回滚 = 换回来**。
- 无本地 LLM 时，2C2G 小主机或树莓派 4B 即可跑（NFR-07）；v1 定位 1–3 个房间同时开团。

这意味着你不需要懂容器编排。会 `cp` 就会运维。

## 2. 快速开始

```bash
pnpm install --frozen-lockfile --prod
pnpm build

# 密钥只走环境变量，不写进任何文件（NFR-03）
export AIDLE_LLM_KEY=sk-xxxx
export AIDLE_ADMIN_TOKEN=自己起一个长随机串   # 可选，见 §5

node packages/server/dist/index.js
```

默认监听 `127.0.0.1:8787`。健康检查：

```bash
curl http://127.0.0.1:8787/healthz
# {"ok":true,"name":"BehindVeil-server","protocol":"..."}
```

`data/config.yaml` 可改监听地址与端口、LLM 端点与模型。**改 llm 段即可换服务商**（凡兼容 `/v1/chat/completions` 的端点都走 openai-compat），不需要改代码。

## 3. data/ 目录长什么样

```
data/
├── config.yaml                 # 非敏感配置（key 不在这里）
├── rooms/<roomId>/
│   ├── room.json               # 房间信息（v3 起带 schemaVersion 信封）
│   ├── members.json            # 成员名单（v1 起为 { schemaVersion, members } 对象根）
│   ├── worldbook.json          # 房间级手编世界书（用户资产，无版本字段）
│   └── sessions/<sessionId>/
│       ├── session.json        # 会话（含 settings / synopsis）
│       ├── messages.jsonl      # 消息流（append-only）
│       └── state.json          # 状态板
├── cards/                      # 角色卡库
├── modules/<moduleId>/         # 模组包
├── index/                      # v3：服务端运行时元数据（热备游标等）
└── logs/audit-dice.jsonl       # 骰子审计流水（全局）
```

- 追加型数据用 JSONL，快照型用 JSON，写文件先落临时文件再原子改名——**断电不会留下半截文件**。
- 启动时自动做一次恢复扫描：坏行跳过并告警，会话与消息照常恢复（NFR-06）。
- 剧情梗概（`session.json` 的 `synopsis`）v1 由 Host 直接手编该文件维护，没有运行时编辑界面。

### 3.1 存档版本门禁（v3 增补）

服务端写入的 JSON 存档带 `schemaVersion` 根字段。启动检测到版本不符（含未迁移的 v2.0 存量）**拒绝启动**并明示命令，迁移流程见 [backup.md §3](./backup.md)：

```bash
pnpm aidle-migrate
```

### 3.2 运行时热备（v3 增补）

```bash
export AIDLE_BACKUP_DIR=/path/to/backup   # 未设置 = 关闭（行为与 v2.0 一致）
export AIDLE_BACKUP_INTERVAL_MS=60000     # 可选，默认 60s
```

增量同步（JSONL 按偏移续传、小文件 hash 比对、崩溃续传、删除镜像）与备份校验工具详见 [backup.md](./backup.md)。

## 4. 备份、迁移、恢复

```bash
# 备份（服务运行中也可以复制；如需绝对一致，先停服务）
cp -a data/ data-backup-$(date +%F)/

# 迁移：把整个目录拷到新机器，启动即可

# 回滚：停服务 → 换目录 → 启动
```

不用导出/导入工具，不用停机维护窗口（追求严格一致时才停）。

**校验骰子审计流水**（可选，适合"这局的骰子有没有被动过"这类争议）：

```bash
node packages/server/dist/tools/audit-replay.js data/logs/audit-dice.jsonl
# 审计复现：N/N 条一致 → 退出码 0；有不一致 → 退出码 1 并列出流水号
```

它用流水里的「骰式 + 原始骰值」重算合计与判定，验证的是**算得对不对**——不是重新摇出同样的点数（CSPRNG 本就没有种子，不可回放）。

## 5. 管理面与访问控制

管理接口（建房、房间列表、重置邀请码、结束会话、导出日志）走 HTTP，共用一套门禁：

| 环境变量 | 未设置 | 已设置 |
|---|---|---|
| `AIDLE_ADMIN_TOKEN` | 管理面不启用门禁（零配置，**完全依赖网络边界**，仅适合本机/内网） | 除 `/healthz` 外全部管理接口必须带 `X-Admin-Token` 头，否则 401 |

一旦要让服务能被局域网以外的人访问，**必须设置这个变量**。

玩家进房靠 6 位邀请码（建房时生成，Host 可重置），与 Admin Token 是两条独立的门。

## 6. 公网部署（⚠️ 风险先读这一节）

R-06 的对策就一句话：**默认内网，公网必须加反向代理 + TLS**。

推荐顺序：

1. **首选 Tailscale / 同类组网**：服务继续监听 `127.0.0.1`，朋友装个客户端就能进，不暴露任何公网端口。对 3–6 人的跑团来说这几乎总是最优解。
2. **确实要放公网**：前置 Nginx / Caddy 做 TLS 终止，反代到 `127.0.0.1:8787`，并开启限速与访问日志。

必须做到：

- [ ] 设置 `AIDLE_ADMIN_TOKEN`（否则管理面对全网敞开）
- [ ] TLS 证书（Caddy 可自动签发；自签证书会让浏览器告警）
- [ ] 反代层限速（例如每 IP 每秒若干请求），挡住扫描器
- [ ] 反代转发 WebSocket 升级头（`Upgrade` / `Connection`），否则实时消息连不上
- [ ] 不把 `data/` 暴露在静态目录下（里面有邀请码、会话全文与审计流水）

不要做：把 `8787` 端口直接裸奔到公网、把 `AIDLE_LLM_KEY` 写进 `config.yaml`（会被启动校验拒绝，这是故意的）。

## 7. 导出跑团日志

```bash
# Markdown
curl -H "X-Admin-Token: $AIDLE_ADMIN_TOKEN" \
  "http://127.0.0.1:8787/rooms/<roomId>/sessions/<sessionId>/export" -o log.md

# 染色 HTML（自包含单文件，双击即开）
curl -H "X-Admin-Token: $AIDLE_ADMIN_TOKEN" \
  "http://127.0.0.1:8787/rooms/<roomId>/sessions/<sessionId>/export?format=html" -o log.html
```

- 只支持 `format=md`（默认）与 `format=html`。
- 导出是 **Host 视角完整版**：暗骰、仅 Host 可见的场外消息照实导出并打标记。
  隐藏的是广播范围，不是凭据——审计本来就完整记录。**分享给玩家前请自行删减。**
- 世界书里标了 `kpOnly` 的条目（模组真相）**不会**出现在任何导出产物中。
- 骰子记录含审计五要素：骰式、原始骰值、合计、判定、流水号（另附 rollId）。

## 8. 常见情况处理

| 现象 | 处理 |
|---|---|
| 启动报 `config.yaml 含敏感字段` | 把 key 从配置文件删掉，改用 `AIDLE_LLM_KEY` 环境变量 |
| 启动报 LLM 适配器装配失败 | 服务照常起来，只是 AI 功能停用；检查 `baseUrl`/`model` 与 key |
| 启动报「存档版本与当前服务端不符，拒绝启动」 | 停服务后跑 `pnpm aidle-migrate`（详见 [backup.md §3](./backup.md#3-存档版本化与-aidle-migrate)） |
| 启动日志出现坏行告警 | 恢复扫描跳过了损坏行，其余数据正常；从备份补回该段即可 |
| 玩家连不上实时消息 | 反代是否转发了 WebSocket 升级头（见 §6） |
| 想换 LLM 服务商 | 改 `data/config.yaml` 的 `llm` 段 + 换 `AIDLE_LLM_KEY`，重启 |
| 磁盘增长 | 主要在 `messages.jsonl` 与 `logs/audit-dice.jsonl`；归档旧会话目录即可 |
