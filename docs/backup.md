# 备份与存档迁移

> 追溯：FR-30（存档版本化与迁移器）、FR-31（运行时热备）、FR-32（备份/恢复校验）、ADR-3-04/05。
> 适用版本：v3。本文是备份、恢复与存档迁移的**唯一**口径来源。

## 1. 双层策略（推荐配置）

| 层 | 手段 | RPO | 用途 |
|---|---|---|---|
| 热备层 | `AIDLE_BACKUP_DIR` 增量同步（默认 60s 一轮） | 分钟级 | 误删/损坏后的快速回退，服务运行中自动进行 |
| 冷备层 | 周期停机整拷 `data/`（或对热备目录再整拷） | 天/周级 | 迁移机器、长期归档、热备目录本身损坏时的兜底 |

两层独立存放（不同磁盘/目录），任何一层失效都还有另一层。**备份目录必须放在 `data/` 之外**（放进去会被拒绝启动同步：会自我嵌套备份）。

## 2. 热备：AIDLE_BACKUP_DIR

```bash
# 启动服务时多给两个环境变量即可
export AIDLE_BACKUP_DIR=/path/to/backup            # 未设置 = 热备关闭（行为与 v2.0 一致）
export AIDLE_BACKUP_INTERVAL_MS=60000              # 可选，默认 60s
node packages/server/dist/index.js
```

工作方式（ADR-3-04）：

- 每轮扫描 `data/` 全部文件，与上一轮游标（`data/index/backup-cursor.json`，原子写）比对：
  - **JSONL**（消息流、审计流水）：按字节偏移**续传**，只复制新增部分；崩溃中断后从游标续传，备份意外超前于游标时先截断再续（幂等收敛）；
  - **其他文件**（JSON/YAML/模组资源）：mtime+size 快路命中即跳过，否则 sha256 比对，不同才整份原子复制；
  - 源侧删除的文件，备份侧**镜像删除**。
- 同步器**只读 `data/`**，不参与任何业务写路径，不占用房间串行队列；对主链路的开销预算：fsync p99 增量 <5ms（G-M10 实测达标）。
- 同步失败不阻断主链路：告警后等下一轮重试。
- `data/index/` 与历史迁移备份目录（`backup-pre-migrate-*`）不在备份范围。

验证热备产物：

```bash
node packages/server/dist/cli/aidle-verify-backup.js /path/to/backup [--sample 100]
# 报告 JSONL 解析率 + 骰子审计复算抽样 + rooms/ 存档 JSON 校验；全部一致退出码 0
```

## 3. 存档版本化与 aidle-migrate

v3 起服务端写入的 JSON 存档（room / members / roster / session / state）都带根字段 `schemaVersion`（v2.0 封版存档定版 1）。消息 JSONL 追加型不迁移；角色卡、模组、房间级世界书属用户资产，靠装载校验兜底，不在迁移器管辖内。

**启动门禁**：检测到存档版本不符（含未迁移的 v2.0 存量）即**拒绝启动**并明示命令——宁可拒绝，不静默猜。

```bash
pnpm aidle-migrate            # 等价于下行；dataDir 默认 ./data
node packages/server/dist/cli/aidle-migrate.js [dataDir]
```

流程（全部自动，失败即回滚）：

1. **校验**：损坏 JSON / 版本超前（存档来自更新版本的服务端）→ 中止，零副作用；
2. **备份**：整目录复制 `data/` → `data/backup-pre-migrate-<时间戳>/`（不嵌套复制历史迁移备份）；
3. **升级**：沿注册表迁移链逐文件原子改写；
4. **自检**：全部存档重解析 + Schema 校验 + JSONL 解析率报告；任一步失败自动从备份还原并退出码 1。

幂等：全部存档已是当前版本时直接成功返回，不产生备份目录。**迁移必须在服务端停止后运行**。

## 3.5 跨房间索引与 aidle-reindex（M11，FR-34）

`data/index/global.jsonl` 是**派生索引**：消息落盘时同批追加一行，供 `GET /search` 跨房间检索
（KP 事后找「那句话发生在哪个团」）。它永不回写消息本体，坏了就重建：

```bash
pnpm aidle-reindex              # 等价于下行；dataDir 默认 ./data
node packages/server/dist/cli/aidle-reindex.js [dataDir]
```

要点：

- **重建 = 先删后建**（函数自带幂等，重复执行不会叠加），报告条目数与消息坏行数；
  消息坏行只如实上报，重建**不修复消息**（那是恢复器/迁移器的辖区）。
- 索引不在迁移管辖内（它不是存档），也不必备份——丢了大不了重建一次。
- 索引是 Host 视角完整版，**含暗骰行**：可见性过滤只发生在消息投递通道
  （`GET /rooms/{id}/messages`），两套口径不混用。

## 4. 恢复演练清单（建议每季度走一遍）

- [ ] 停服务；确认 `aidle-verify-backup` 对热备目录全绿（退出码 0）
- [ ] 把 `data/` 改名留作现场，将热备目录复制为 `data/`，启动服务
- [ ] 用真实玩家账号进房：历史消息、状态板、名册完整；掷一颗骰子
- [ ] `audit-replay` 复核恢复后的审计流水全绿
- [ ] 恢复完毕后保留原 `data/` 现场直至下一个冷备周期结束

```bash
node packages/server/dist/tools/audit-replay.js data/logs/audit-dice.jsonl
```

## 5. 常见问题

| 现象 | 处理 |
|---|---|
| 启动报「存档版本与当前服务端不符，拒绝启动」 | 按提示跑 `pnpm aidle-migrate`；先停服务 |
| 启动报「AIDLE_BACKUP_DIR 不能位于 data/ 内部」 | 把备份目录挪出 `data/` |
| 热备日志出现「同步失败（下一周期重试）」 | 看当轮报错：常见为备份盘满/权限；主链路不受影响，修复后自动追平 |
| `aidle-migrate` 报「版本超前」 | 存档来自更新版本的服务端，不能用旧版程序降级打开；升级服务端 |
| 迁移中断/自检失败 | 已自动回滚到 `backup-pre-migrate-<时间戳>/` 原貌；修复原因后重跑 |
| 手编 `room.json` / `worldbook.json` | room.json 已带版本信封（改内容别删 `schemaVersion` 字段）；房间级 worldbook.json 是用户资产，无版本字段，装载时校验 |
