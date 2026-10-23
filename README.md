# BehindVeil

[![CI](https://github.com/Anguis-L/BehindVeil/actions/workflows/ci.yml/badge.svg)](https://github.com/Anguis-L/BehindVeil/actions/workflows/ci.yml)

Behind the veil, the Keeper speaks.

A self-hosted, open-source TRPG platform where an AI plays the Keeper. The AI narrates and requests checks; the server rolls the dice. Dice results come from a CSPRNG with an audit trail, so every roll is fair and reproducible. Narrative belongs to the LLM; rules belong to the code.

一个自托管、开源、多人在线的文字跑团（TRPG）平台。3–6 名玩家通过浏览器进房，AI 扮演守秘人（KP）负责叙事、扮演 NPC、请求检定，而掷骰与判定永远由服务端执行。

它解决什么问题
现有的 AI 跑团工具大多把规则和骰子一起交给了大模型——AI 自己"脑内出数"，既不可信也不可审计。Veil 把这件事拆开：

AI 负责叙事：讲述、扮演、判断"此刻该不该检定"，并通过结构化指令块请求检定
引擎负责判定：解析骰式、按规则书裁定、用 CSPRNG 掷骰，结果回注给 AI 继续讲故事
也就是说——叙事交给 LLM，规则交给代码。每一掷都带流水号与原始骰值，事后可复现验证。

核心特性
🎲 服务端权威骰子	骰式表达式 + 可插拔规则书（COC 7e / D&D 5e / generic 三规则书：5e 支持 DC/AC 判定、nat20/nat1 面值规则、优势/劣势、对抗检定）
🔁 检定闭环	AI 发指令 → 引擎掷骰 → 结果回注 → AI 续写，单轮循环上限 3 次兜底
🩹 数值自动化	AI 可请求伤害/治疗/理智检定（damage/heal/sanity），服务端掷骰后自动写状态板（HP/SAN clamp 到合法区间），全程审计
📖 世界书	关键词/正则触发、二级键逻辑、token 预算控制；kpOnly 条目标记模组真相——AI 知道但不能说
🎴 角色卡	兼容 chara_card_v3（PNG / JSON 双格式），COC7 / D&D 5e 两套字段体系判别分流，旧数据零迁移
📋 状态板	HP/SAN/AC/技能等数值的权威追踪，快照常驻注入，纠正 AI 叙事中的数值漂移；Host 转让与副 Host 掉线代行
📦 模组包	一个目录 = KP 人格 + 世界书 + 初始状态，可加载、可卸载、可分享；内置原创 5e 示例模组「雾桥驿站」
🔍 可观测	KP 端可预览每次请求的 prompt 组装过程：命中了哪些条目、各阶段 token 用量
💾 数据主权	全部落本地文件（JSONL + JSON），备份 = 复制 data/ 目录；写前持久化，崩溃重启消息零丢失

v3 新增能力（性能与内容方向，M10–M13）
- ⚡ **性能基线与回归闸**：NFR-10 六项指标对比 `baseline.json` 常开，劣化当周暴露；存档全类带 `schemaVersion`，结构变更必附迁移函数（`aidle-migrate`），备份附 `aidle-verify-backup` 校验与热备。
- 🔎 **向量召回 + 世界书编辑器 + AI 梗概**：混合召回（向量 + 关键词）带预算与可关断开关，房间层世界书编辑（全量替换保存），被裁历史自动梗概，跨房间全局索引（`aidle-reindex`）。
- ⚔️ **战斗辅助**：状态条 conditions 对象化（带到期提示）、通用资源计数器（AI 只能说「消耗几个」）、先攻看板（玩家提请加入，Host 手动推进，无自动结算红线）。
- 🎲 **generic 第三规则书**：KP 卡 JSON 全权定义判定（骰型/方向/档表/对抗平局），`when` 受限文法手写解析、装载时编译缓存；配置快照进会话，审计复现照常。RuleBook 接口经受三次实现验证，正式成为平台能力。

不做这些
战术地图与令牌（那是 Foundry 的领域）、语音/立绘、万人级并发 SaaS、移动端原生 App——v1 明确不做，防止范围蔓延。

技术栈
Node.js 22 · TypeScript（strict）· Fastify · Socket.IO · Vue 3 · Zod · Vitest，pnpm workspace 单仓。单进程部署，无本地 LLM 时 2C2G 小主机或树莓派即可运行。

项目状态
✅ **v3.0.0 已封版**：v1（COC7 全闭环，M0–M6）+ v2（D&D 5e 规则扩展，M7–M9）+ v3（性能与内容方向：性能基线/迁移器/热备、向量召回/编辑器/AI 梗概、战斗辅助、generic 第三规则书，M10–M13）。`pnpm verify` 全绿（1213 个测试、覆盖率 ≥85%、无 AGPL/GPL），2C2G 限资源冒烟通过（默认配置行为 = v2.0，RSS ≈ 90MB）。

真实短团验收（2026-10-10，5e 示例模组单人局）已完成，如实结论：**功能全链路可用**（开团/检定闭环/审计流水/断线重连/导出），但暴露了两个问题——① **AI 回合可能没有收尾**（玩家发言后界面挂住）已在封版轮修复：现在任何 AI 回合都会以 `narration:done` 收尾，整轮没有可见叙事也会落一条玩家提示，绝不沉默；② **AI 剧情引导不足**（不主动推进剧情、收尾句式复读、场景状态不随叙事更新）属设计层能力缺口，已单独立项为下一里程碑（M14）。

下一步：M14「KP 叙事引导与剧情推进」。

开发与质量门禁
```bash
pnpm install
pnpm verify      # 格式 → lint → 构建 → 类型检查 → 测试覆盖率 → 许可证扫描
```
推送 `main` 或提交 PR 会自动运行 `.github/workflows/ci.yml`。两条硬性门禁：覆盖率 ≥ 85%（NFR-09）、依赖树出现 AGPL/GPL 即失败（NFR-08）。

发布与部署（自托管）
```bash
git tag v0.1.0 && git push --tags    # 触发 .github/workflows/release.yml
```
自动生成 `behindveil-v0.1.0.zip` 与 SHA256 校验文件。部署时在服务器上：

1. 解压，`sha256sum -c` 校验完整性
2. `pnpm install --frozen-lockfile --prod` 安装依赖
3. 用环境变量注入 LLM 配置（如 `AIDLE_LLM_KEY`），**不要写进文件**
4. 启动服务，运行时数据全部落在 `data/`，备份即复制该目录

公网部署务必配合反向代理 + TLS，或直接使用 Tailscale 组网。

### 第一次用：三步开团（都在网页上点，不用敲命令行）

1. **建房间** —— 打开首页 → 切到「新建房间」→ 填房间名和你在本房的昵称 → 创建。
   页面会给你一个 **6 位邀请码**，发给朋友，他们在首页选「加入房间」输码就能进来。
2. **接一个 AI** —— 首页或右栏「KP 控制台」点 **⚙ AI 模型设置**：选服务商（DeepSeek / 智谱 / Kimi / 通义 / Ollama…）
   → 填密钥 → **测试连接**（连不上会直接告诉你是地址错、密钥错还是网络不通）→ 保存。
   改完**立即生效，不用重启服务**；密钥只存在服务内存里，不写进任何文件。
3. **选剧本、认领角色** —— KP 控制台「开团」选一个剧本（新机器还没有剧本，点一下
   **装载内置示例剧本** 即可）→ 右栏「角色卡」标签导入玩家角色卡或填速建表 → 绑到对应成员 → 开团。

开团前建议先点一次「测试连接」：AI 没接好，团是跑不动的，早测早知道。

### 5 分钟跑一场 5e 团（示例模组）

仓库自带原创短篇模组 **「雾桥驿站」**（`examples/modules/fogbridge-5e/`，D&D 5e：断桥清障、查案、御兽一夜完团）：

```bash
node scripts/seed-example-module.mjs   # 把示例模组复制进 data/modules/（幂等，已有则跳过）
```

然后：建房（网页上点就行，见上一节）→ 玩家用邀请码进房 → KP 控制台「开团」选剧本 `fogbridge-5e` →
在右栏「角色卡」标签用 **D&D 5e 速建表模板**给玩家录卡并声明到成员 → 开始叙事。
（命令行党也可以照旧执行上面的种子命令，效果一样。）

模组覆盖 5e 全部机制触发点：属性检定（挪横梁·力量）、豁免（烈酒·体质）、攻击（夜嚎兽·AC 13）、
伤害/治疗（服务端掷骰自动写状态板 HP）、优势/劣势（高台 `adv` / 浓雾 `dis`，玩家手骰骰式末尾直接加）。
发布包已内置 `examples/`，部署后执行同一条种子命令即可。

### 5 分钟跑一场 generic 团（自定义判定表）

仓库另带原创短篇模组 **「灰岬灯塔夜班」**（`examples/modules/greycape-generic/`）：
不绑定任何商业规则，判定是自创的「灯芯规」——`2d6+修正>=7` 三档（6 以下失手 / 7-9 成功有代价 / 10 起大成），
KP 卡 JSON 一份配置说了算。种子命令同上，KP 控制台选模组 `greycape-generic` 开团即可；
建议玩家用 **D&D 5e 速建表**录卡（属性调整值即修正），Host 可顺手给每位 PC 挂「灯油」资源计数器体验 AI 消耗。
generic 的配置语法与红线见 [docs/API.md](docs/API.md)。

### 环境变量

| 变量 | 作用 | 不设置会怎样 |
|---|---|---|
| `AIDLE_LLM_KEY` | LLM 的 API Key（只走环境变量，不写进 `data/config.yaml`） | 真实 provider 装配失败，AI 功能停用（服务主体不受影响） |
| `AIDLE_ADMIN_TOKEN` | **管理面门禁**：设置后，管理类接口必须带 `X-Admin-Token` 头 | **管理面完全开放**——任何能访问该端口的人都能建房、改配置、删角色卡。启动时日志会打一条告警 |

⚠️ 自托管务必设置 `AIDLE_ADMIN_TOKEN`，尤其是端口对局域网/公网可见时。设置了它**不会**影响玩家正常使用：翻历史、`/rooms/{id}/public` 这类玩家端点是免令牌的（详见 [docs/API.md](docs/API.md)）。

完整部署与运维口径（data/ 目录布局、备份与恢复、公网暴露检查清单、审计流水校验、日志导出）见 [docs/deployment.md](docs/deployment.md)。
