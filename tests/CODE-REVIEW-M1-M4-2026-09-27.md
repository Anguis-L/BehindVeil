# M1-M4 代码审核报告

> 审核日期：2026-09-27
> 审核范围：M1（房间/会话/消息/鉴权）、M2（世界书+管线+预览）、M3（AI指令协议+检定闭环）、M4（骰子引擎+规则书+审计）
> 设计依据：`00.development/AI_KP_SDD_系统设计文档_v1.md`、`AI_KP_TDD_技术设计文档_v1.md`

---

## 一、M1 模块（房间/会话/消息/鉴权）

### 高严重度（4 个）

| # | 文件 | 行号 | 问题 | 违反条款 |
|---|------|------|------|----------|
| 1 | `sessions.ts` | 13 | **依赖 M5 模块**：`import { readRoomRoster } from '../stateboard/declare.js'`，stateboard 是 M5 里程碑模块，M1 阶段不应存在此依赖 | AGENTS.md 里程碑推进原则 |
| 2 | `sessions.ts` | 25-26 | **M5 功能混入 M1**：`CreateSessionInput` 包含 `initState` 字段，属于 M5 里程碑功能 | AGENTS.md 里程碑推进原则 |
| 3 | `sessions.ts` | 66-79 | **M5 功能混入 M1**：`createSession` 中创建 `state.json` 并初始化 `pcs`，涉及 T-M5-04 的 PC 声明逻辑 | AGENTS.md 里程碑推进原则 |
| 4 | `sessions.ts` | 144-156 | **M6 功能混入 M1**：`updateSessionSettings` 函数注释标注为 T-M6-04，属于 M6 里程碑功能 | AGENTS.md 里程碑推进原则 |

### 中严重度（5 个）

| # | 文件 | 行号 | 问题 | 违反条款 |
|---|------|------|------|----------|
| 5 | `rooms.ts` | 3-4 | **分层架构违规**：domain 层直接 import adapters 层的 `JsonStore` 和 `DataLayout` | SDD §3.1 分层架构 |
| 6 | `rooms.ts` | 58-72 | **hostToken 泄露风险**：`listRoomFiles` 返回含 `hostToken` 的 `RoomFile`，调用方必须记得调用 `toPublicRoom` 剥离 | TDD §8 安全要求 |
| 7 | `rooms.ts` | 74-80 | **hostToken 泄露风险**：`findByInviteCode` 返回含 `hostToken` 的 `RoomFile` | TDD §8 安全要求 |
| 8 | `sessions.ts` | 11 | **分层架构违规**：domain 层直接 import adapters 层的 `JsonStore` | SDD §3.1 分层架构 |
| 9 | `messages.ts` | 102-103 | **可见性控制缺陷**：`canSee` 函数中 `viewer` 为 `null` 时返回 `true`（全部可见），若调用方忘记传 viewer，暗骰和密语会对所有人可见 | TDD §8 安全要求（D-10 暗骰可见性） |

### 低严重度（4 个）

| # | 文件 | 行号 | 问题 | 违反条款 |
|---|------|------|------|----------|
| 10 | `rooms.ts` | 15 | **hostToken 字段不在 TDD §3.1 定义中**：`RoomFileSchema` 扩展了 `hostToken` 字段 | TDD §3.1 Room 数据结构 |
| 11 | `rooms.ts` | 37-39 | **defaultSessionSettings 字段不在 TDD §3.1 定义中** | TDD §3.1 Room 数据结构 |
| 12 | `sessions.ts` | 78 | **synopsis 字段不在 TDD §3.1 定义中**：SessionSchema 包含 `synopsis` 字段 | TDD §3.1 Session 数据结构 |
| 13 | `jsonl-store.ts` | 31 | **故障注入点在生产代码中**：`maybeCrashAfterWrite()` 在 `append` 方法中调用 | CODING_STANDARDS 安全实践 |

### 审核通过项

- Room 数据结构：id(nanoid 12)、name、createdAt(ISO8601)、inviteCode(6位)、activeSessionId、memberLimit(默认8) 均符合 TDD §3.1
- Session 数据结构：id、roomId、moduleRef、startedAt、endedAt、stateBoardVersion(乐观锁)、settings 均符合 TDD §3.1
- Message 数据结构：六类消息类型、BaseMsg 含 seq/ts/sessionId 均符合 TDD §3.2
- 存储布局：`data/rooms/<roomId>/room.json`、`sessions/<sessionId>/session.json`、`messages.jsonl`、`state.json` 均符合 TDD §6
- WAP 实现：`appendMessage` 先 fsync 追加 JSONL，返回后才可广播，符合 TDD §6 NFR-06
- 原子写：`write-tmp → fsync → rename` 模式正确实现，符合 TDD §6
- ID 生成：全部使用 nanoid CSPRNG，符合 NFR-04

---

## 二、M2 模块（世界书+管线+预览）

### 高严重度（2 个）

| # | 文件 | 行号 | 问题 | 违反条款 |
|---|------|------|------|----------|
| 1 | `pipeline/stages.ts` | 139-172 | **constant/kpOnly 条目参与 S4 预算竞争，可被裁掉**：S4 预算裁剪将所有扫描命中条目（包括 `constant` 常驻条目和 `kpOnly` 模组真相条目）统一按 weight 排序装入，超预算即裁掉。当预算不足时，`constant` / `kpOnly` 条目会出现在 `droppedUids` 中 | TDD §5.1 S3："常驻条目恒入；kpOnly 条目永远注入" |
| 2 | `domain/worldbook/scan.ts` | 86 | **空字符串关键词导致无条件命中**：`corpus.includes('')` 恒为 `true`。若世界书条目 `key: ['']` 或 `keysecondary: ['']`，该条目将无条件命中。`validate.ts:46` 只检查 `entry.key.length === 0`（数组为空），无法发现数组内的空字符串 | TDD §3.4："key: string[] // 主关键词" — 隐含非空语义 |

### 中严重度（5 个）

| # | 文件 | 行号 | 问题 | 违反条款 |
|---|------|------|------|----------|
| 3 | `domain/worldbook/scan.ts` | 27 | **recursionDepth 无上限校验**：若传入极大值，语料每轮整段并入、每轮全量重扫，复杂度随轮数指数化 | TDD §5.2："recursionDepth=1，防循环" |
| 4 | `domain/worldbook/scan.ts` | 78-86 | **正则关键词无长度/复杂度限制，存在 ReDoS 风险**：恶意或手误的超长正则（如 `(a+)+$`）配合增长的语料可阻塞事件循环 | CODING_STANDARDS §1.2 安全编码实践 |
| 5 | `pipeline/stages.ts` | 263 | **S7 硬顶可能为负数**：若 `outputReserveTokens > contextWindowTokens`，`hardCap` 为负数，历史被裁到 0 后仍标记 `overBudget = true` 并照发 | TDD §5.1 S7："总 token ≤ 硬顶" |
| 6 | `domain/worldbook/scan.ts` | 26-46 | **递归语料无预算，指数增长**：每轮递归将命中条目 content 整段并入语料，无总长度上限 | TDD §5.2 复杂度约束 |
| 7 | `pipeline/stages.ts` | 166-171 | **S4 trace 未标记被裁条目的 constant/kpOnly 身份**：KP 预览时需要交叉引用 S3 trace 才能发现"常驻条目被裁了"这一异常 | TDD §9："被裁剪条目" 应可观测 |

### 低严重度（3 个）

| # | 文件 | 行号 | 问题 | 违反条款 |
|---|------|------|------|----------|
| 8 | `pipeline/stages.ts` | 124 | **S3 阶段 tokenCount 记录为 0**：S3 是扫描阶段，产物是命中条目集而非文本，trace 中 `tokenCount` 硬编码为 `0` | TDD §5.1："每阶段记录 tokenCount" |
| 9 | `domain/worldbook/scan.ts` | 83 | **console.warn 使函数不纯**：`scanWorldBook` 不再是严格意义上的纯函数，副作用会影响黄金用例的可重复性 | SDD §3.1："L2 是纯函数" |
| 10 | `pipeline/types.ts` | 60-62 | **PipelineDeps 接口为死代码**：已导出但无任何消费者 | CODING_STANDARDS §1.2 |

### 审核通过项

- WorldBookEntry Schema 字段 vs TDD §3.4：完全匹配
- 四种 selectiveLogic 语义 vs TDD §5.2：完全匹配（0=AND_ANY, 1=NOT_ALL, 2=NOT_ANY, 3=AND_ALL）
- 正则关键词 `/regex/` 形式：正确
- constant 恒命中：正确（scan.ts:50）
- kpOnly 恒命中：正确（scan.ts:50）
- 空 keysecondary 语义：正确（scan.ts:58-60）
- 递归 + uid 去重防循环：正确
- disabled 跳过：正确（scan.ts:34）
- S1→S7 阶段顺序：正确（pipeline.ts:21-29）
- PipelineTrace 结构 vs TDD §5.1：匹配（stages + messages）
- Tokenizer 启发式估算 vs TDD §5.1：匹配（CJK≈1, ASCII≈4:1）
- S4 weight 降序 + order 升序：正确（stages.ts:142-144）
- S5 历史裁剪 + 梗概注入：正确（stages.ts:182-193）
- S6 按 position 插入：正确（stages.ts:196-237）
- S7 硬顶回退：正确（stages.ts:261-292）
- redact() 密钥过滤：正确（键名模式 + 字面量替换 + env key）
- 预览返回 PipelineTrace：正确（preview.ts:38-63）
- L2 管线层纯函数：pipeline.ts / tokenizer.ts / stages.ts 无 I/O

---

## 三、M3 模块（AI指令协议+检定闭环）

### 高严重度（1 个）

| # | 文件 | 行号 | 问题 | 违反条款 |
|---|------|------|------|----------|
| 1 | `loop.ts` | 101-179 | **指令块未从叙事中剥离**：`scan.ts` 的 `DirectiveScanEvent` 明确提供 `start`/`end` 绝对字符区间（scan.ts:12 注释："供闭环编排器从叙事全文剥离指令块"），但 `loop.ts` 的 `content` 数组直接拼接所有 delta（包括指令块），`finishNarration` 落盘的 `NarrationMsg` 会包含原始 JSON 指令块（如 `{"op":"check",...}`）。玩家将在叙事中看到内部协议格式 | TDD §5.4（指令块是 AI 与引擎之间的内部协议） |

### 中严重度（2 个）

| # | 文件 | 行号 | 问题 | 违反条款 |
|---|------|------|------|----------|
| 2 | `loop.ts` | 161 | **emitNarrationDelta 广播指令块**：`ports.emitNarrationDelta(triggerSeq, delta)` 在 `onDelta` 回调中直接广播原始 delta，指令块会被实时推送到前端。前端将看到内部协议 JSON，而非纯叙事文本 | TDD §5.4（指令块不应出现在玩家可见输出） |
| 3 | `socket.ts` | 163 | **memberInvokeRound 内存泄漏**：玩家离开房间时，`memberInvokeRound` Map 中的记录未被清理。长期运行下，已离开玩家的 memberId 会永久驻留内存 | SDD §3.1 内存管理最佳实践 |

### 低严重度（2 个）

| # | 文件 | 行号 | 问题 | 违反条款 |
|---|------|------|------|----------|
| 4 | `socket.ts` | 907-938 | **ai:invoke 的 reason 字段未使用**：TDD §4.1 定义 payload 为 `{ reason?: string }`，但 `handleAiInvoke` 完全忽略该字段 | TDD §4.1（`ai:invoke` payload 定义） |
| 5 | `loop.ts` | 175-179 | **finishNarration 的 aborted 参数被忽略**：中断的叙事仍会触发 `narration:done`，前端无法区分正常完成与中断完成 | TDD §5.4（流中断处理） |

### 审核通过项

- 指令块格式（TDD §5.4）：`schema.ts` 的 `CheckDirectiveSchema` 严格匹配 TDD 定义，`strictObject` 拒绝未知字段
- 处理循环（TDD §5.4）：`loop.ts` 的 `MAX_CHECKS_PER_TURN = 3`，流式扫描 → JSON 解析 → op 白名单 → 引擎执行 → DiceMsg 广播 → SystemMsg 回注 → 续写，循环上限正确
- 降级链（TDD §5.4）：`degrade.ts` 窗口 20 次、阈值 95%（失败率 > 5%），`loop.ts` 一级降级注入少样本、二级降级停用协议并提示 `.r`
- AI 触发策略（TDD §5.4）：IC 消息自动触发 + `ai:invoke` 显式触发，`enqueueAi` 串行队列，每人每轮 1 次
- DiceMsg（TDD §3.2）：`hidden: boolean`、`senderId?` 缺省 = 引擎代掷，AI 检定骰 `hidden: false` 正确
- SystemMsg（TDD §3.2）：`subtype: 'ai_directive_result'` 正确
- 分层架构（SDD §3.1）：`loop.ts` 不 import gateway，ports 注入；`executor.ts` 不感知 LLM 协议；`socket.ts` 做路由与校验

---

## 四、M4 模块（骰子引擎+规则书+审计）

### 中高严重度（1 个）

| # | 文件 | 行号 | 问题 | 违反条款 |
|---|------|------|------|----------|
| 1 | `rulebook/coc7.ts` + `shared/dice.ts` | 96-99 / 30-31 | **fail（难度未达）的 grade 语义与 shared 层注释直接矛盾**：`coc7.ts:98` 当 KP 要求的难度档未达时返回 `{ outcome: 'fail', grade: natural }`，其中 `natural` 可能是 `'extreme'`/`'hard'`/`'normal'`。但 `shared/dice.ts:30-31` 注释明确写"critical / fail / fumble 的 grade 恒为 normal"。二者直接矛盾 | TDD §3.5 `grade` 语义（"成功子等级"）；shared 层文档一致性 |

### 中严重度（8 个）

| # | 文件 | 行号 | 问题 | 违反条款 |
|---|------|------|------|----------|
| 2 | `rulebook/types.ts` | 72 | **RuleBook 接口超出 TDD §5.3 定义**：`adjudicateOpposed?(a: OpposedSide, b: OpposedSide): OpposedResult` 是 TDD §5.3 RuleBook 接口没有的方法 | TDD §5.3 RuleBook 接口定义 |
| 3 | `dice/audit.ts` | 108-116 | **seq 恢复取"最后一条可解析行"而非"最大 seq"**：若文件内 seq 非单调（手工编辑/损坏），恢复后 counter 从尾部较小值开始，可能产生重复 seq | TDD §5.3 "seq 全局单调" |
| 4 | `dice/audit.ts` | 65-73 | **counter 自增在 append 之前，失败时 seq 跳号**：若 append 失败（磁盘满），counter 已自增，seq 跳号 | TDD §5.3 "seq 全局单调" |
| 5 | `dice/evaluator.ts` | 164-178 | **replayRoll 不校验 rolls 值域**：复现校验只校验"骰值数量与表达式不符"，但不校验值域。例如 `1d100` 的 rolls 出现 150，只要 total 碰巧一致就能通过复现 | TDD §5.3 "骰值数量与表达式不符视为失败" |
| 6 | `dice/audit.ts` + `evaluator.ts` | — | **写顺序不变式在 M4 模块内无强制**：TDD §5.3 要求"先落审计（fsync）再广播"，M4 模块内 `audit.record()` 返回 `{seq, ts, rollId}`，`evaluator` 不产生 audit，不变式完全依赖调用方遵守 | TDD §5.3 写顺序不变式 |
| 7 | `adapters/storage/jsonl-store.ts` | 35-57 | **JsonlStore.readAll 全量读取，大文件性能/内存问题**：长团（百万行审计）时首次落账慢、复现校验内存压力大 | NFR-05 性能（间接） |
| 8 | `rulebook/coc7.ts` | 26-49 | **Coc7HouseRules 的 fumbleLowSkill/fumbleHighSkill/sanityLossTable 无校验**：矛盾配置如 `fumbleLowSkill=200, fumbleHighSkill=50` 不报错 | 防御性编程（CODING_STANDARDS） |
| 9 | `shared/dice.ts` | 43-47 | **CheckSpecSuffixSchema 死代码**：定义并导出，但全仓库无引用 | 代码整洁（CODING_STANDARDS） |

### 低严重度（6 个）

| # | 文件 | 行号 | 问题 | 违反条款 |
|---|------|------|------|----------|
| 10 | `shared/dice.ts` + `rulebook/coc7.ts` | 57 / 90-94 | **shared 注释"可省略"与实现"显式 normal"表述不一致** | 文档一致性 |
| 11 | `dice/evaluator.ts` | 123-145 | **RollCheck.op 总是显式赋值，方案 a 缺省语义不体现** | TDD §5.3 方案 a |
| 12 | `tools/audit-replay.ts` | 37 | **RULEBOOKS 只有 coc7**：未来 dnd5e 流水会报"未知规则书" | v1 限制，合理 |
| 13 | `rulebook/coc7.ts` | 73 | **parseCheck ctx 缺省 {}**：TDD §5.3 签名无缺省，实现加了便利缺省 | 无害便利 |
| 14 | `rulebook/types.ts` | 25-28 | **ParsedCheck 形状与 TDD 交叉类型不同**：TDD 返回扁平交叉类型，实现返回嵌套 | 语义一致，形状略异 |
| 15 | `dice/random.ts` | 18 | **random.ts int(min, max) 无溢出保护**：对 `max = Number.MAX_SAFE_INTEGER` 会溢出 | 实际调用范围安全 |

### 审核通过项

- 骰式文法 vs TDD §5.3 BNF：**符合**。expr/term/factor/dice/modifier/check 六条产生式全部正确实现，手写递归下降，无第三方库
- RollResult vs TDD §3.5：**符合**。expr/rolls/kept/total/check/audit 字段齐全，audit 必填
- 随机源 CSPRNG：**符合**。`crypto.randomInt`（random.ts:18），无用户可控种子路径
- 审计流水落账：**基本符合**。字段齐全、seq 零填充 6 位、fsync 后返回、单文件追加
- COC7 判定表：**符合**。critical(<=1)/fumble(>=96|100)/极难(<=t/5)/困难(<=t/2)/普通(<=t) 六档语义正确
- 判定后缀消费（方案 a）：**符合**。`<=` 走 adjudicate 六档判定；`>=`/`=` 走布尔判定
- 理智损失默认表：**符合**。critical/extreme=0、hard=1、normal=1d2、fail=1d6、fumble=1d10 完全匹配
- RuleBook 接口：**基本符合**。id/parseCheck/adjudicate/sanityRule? 齐全
- 复现校验器：**符合**。CLI 可直跑、逐条重算、数量不符即报、不消耗随机源
- NFR-04：**符合**。CSPRNG、原始骰值留痕、流水号（seq+rollId）、复现验证全部到位

---

## 五、总结

| 模块 | 高 | 中 | 低 | 总计 |
|------|---|---|---|------|
| M1 | 4 | 5 | 4 | 13 |
| M2 | 2 | 5 | 3 | 10 |
| M3 | 1 | 2 | 2 | 5 |
| M4 | 1 | 8 | 6 | 15 |
| **总计** | **8** | **20** | **15** | **43** |

### 最需要优先修复的问题

1. **M1 sessions.ts 依赖 M5 模块**（问题 #1-3）— 违反里程碑推进原则，M1 阶段不应有 stateboard 依赖
2. **M1 sessions.ts 混入 M6 功能**（问题 #4）— 违反里程碑推进原则
3. **M2 constant/kpOnly 条目被裁**（问题 #1）— 违反 TDD §5.1 S3 核心语义
4. **M2 空字符串关键词无条件命中**（问题 #2）— 世界书核心语义缺陷
5. **M3 指令块未从叙事中剥离**（问题 #1）— 玩家可见内部协议格式，严重影响用户体验
6. **M4 fail grade 语义矛盾**（问题 #1）— 文档与实现不一致，影响消费方
7. **M1 分层架构违规**（问题 #5, #8）— domain 层直接 import adapters 层
8. **M1 hostToken 泄露风险**（问题 #6-7）— 安全隐患
9. **M1 可见性控制缺陷**（问题 #9）— 暗骰和密语可能对所有人可见
10. **M3 指令块广播到前端**（问题 #2）— 前端看到内部协议 JSON
