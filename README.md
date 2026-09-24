# BehindVeil
Behind the veil, the Keeper speaks.

A self-hosted, open-source TRPG platform where an AI plays the Keeper. The AI narrates and requests checks; the server rolls the dice. Dice results come from a CSPRNG with an audit trail, so every roll is fair and reproducible. Narrative belongs to the LLM; rules belong to the code.

一个自托管、开源、多人在线的文字跑团（TRPG）平台。3–6 名玩家通过浏览器进房，AI 扮演守秘人（KP）负责叙事、扮演 NPC、请求检定，而掷骰与判定永远由服务端执行。

它解决什么问题
现有的 AI 跑团工具大多把规则和骰子一起交给了大模型——AI 自己"脑内出数"，既不可信也不可审计。Veil 把这件事拆开：

AI 负责叙事：讲述、扮演、判断"此刻该不该检定"，并通过结构化指令块请求检定
引擎负责判定：解析骰式、按规则书裁定、用 CSPRNG 掷骰，结果回注给 AI 继续讲故事
也就是说——叙事交给 LLM，规则交给代码。每一掷都带流水号与原始骰值，事后可复现验证。

核心特性
🎲 服务端权威骰子	骰式表达式 + 可插拔规则书（首发 COC 7e，含大成功/极难/困难/大失败完整判定语义）
🔁 检定闭环	AI 发指令 → 引擎掷骰 → 结果回注 → AI 续写，单轮循环上限 3 次兜底
📖 世界书	关键词/正则触发、二级键逻辑、token 预算控制；kpOnly 条目标记模组真相——AI 知道但不能说
🎴 角色卡	兼容 chara_card_v3（PNG / JSON 双格式），直接吃下社区存量资产
📋 状态板	HP/SAN/技能等数值的权威追踪，快照常驻注入，纠正 AI 叙事中的数值漂移
📦 模组包	一个目录 = KP 人格 + 世界书 + 初始状态，可加载、可卸载、可分享
🔍 可观测	KP 端可预览每次请求的 prompt 组装过程：命中了哪些条目、各阶段 token 用量
💾 数据主权	全部落本地文件（JSONL + JSON），备份 = 复制 data/ 目录；写前持久化，崩溃重启消息零丢失
不做这些
战术地图与令牌（那是 Foundry 的领域）、语音/立绘、万人级并发 SaaS、移动端原生 App——v1 明确不做，防止范围蔓延。

技术栈
Node.js 22 · TypeScript（strict）· Fastify · Socket.IO · Vue 3 · Zod · Vitest，pnpm workspace 单仓。单进程部署，无本地 LLM 时 2C2G 小主机或树莓派即可运行。

项目状态
🚧 设计中，尚未发布。SDD（系统设计文档）与 TDD（技术设计文档）v1 已完成待评审，按 M0–M6 里程碑推进，每个里程碑设验收门禁，不通过不进入下一阶段。
