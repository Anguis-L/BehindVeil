# 测试用例审查报告

> 审查日期：2026-09-27
> 审查范围：全项目 `*.test.ts` 文件（约 50 个）
> 复核状态：已逐条验证，约 90% 确认，少数描述修正
> 设计文档核实：已对照 `00.development/AI_KP_SDD_系统设计文档_v1.md` 和 `AI_KP_TDD_技术设计文档_v1.md` 核实

---

## 一、高严重度问题（8 个）

### 1. 从 dist/ 导入而非源码

| 文件 | 行号 | 问题 |
|------|------|------|
| `tests/statistical/chi-square.test.ts` | 2 | 从 `../../packages/server/dist/domain/dice/random.js` 导入编译产物，违反 CODING_STANDARDS.md §2.5 "测试与源码同目录"。源码改动后必须重新构建才能运行测试。 |
| `tests/bench/nfr05-bench.test.ts` | 2-7 | 同上，从 `dist/` 导入。 |

### 2. 架构守护测试核心功能缺陷

| 文件 | 行号 | 问题 |
|------|------|------|
| `tests/architecture/dependency-direction.test.ts` | 45 | 正则 `/^\s*(import\|export)\b.*from\s+['"]/` 无法匹配多行 import 语句（如 `import {\n  A,\n} from './foo'`），导致漏检。 |
| 同上 | 71-79, 82-91 | 只检查 `@behindveil/(server\|web)` 包名导入，相对路径（如 `../../server/...`）可绕过检测。 |
| 同上 | 52-57, 63-68, 74-79, 85-90 | 当文件无 import 语句时，内层循环不执行，`expect` 不会被调用，测试静默通过。 |

### 3. 测试可能永不执行

| 文件 | 行号 | 问题 |
|------|------|------|
| `tests/protocol/protocol.test.ts` | 33 | `const suite = protocol ? describe : describe.skip` — 当 protocol 为 null 时整组跳过，可能永远不会被执行。 |
| `tests/http/rest-contract.test.ts` | 83-88 | 探测路由 404 时整组跳过，可能永远不会被执行。 |

### 4. 条件断言导致假通过

| 文件 | 行号 | 问题 |
|------|------|------|
| `packages/shared/src/errors.test.ts` | 51-60 | `describe.skipIf(!hasModCode)` — 若 E-MOD-01 未入表则整个 describe 块静默跳过，错误码表是前后端共享契约，应强制验证。 |
| `packages/server/src/adapters/llm/llm-adapters.test.ts` | 208-231 | 连接被硬切断测试使用 `if (outcome.resolved) { ... } else { ... }` 条件分支断言，可能在某些情况下通过而没有真正验证行为。 |

### 5. Mock 具体方法名

| 文件 | 行号 | 问题 |
|------|------|------|
| `packages/server/src/gateway/socket.test.ts` | 448-469 | `vi.spyOn(JsonlStore.prototype, 'append')` mock 具体方法名，实现改变写盘方式时测试会失败。 |

### 6. Soak 测试消息量不足

| 文件 | 行号 | 问题 |
|------|------|------|
| `tests/soak/soak.test.ts` | 174 | 30 分钟 soak 时 interval=3500ms，每客户端约 514 条，3 端共约 1542 条。消息密度偏低，seq 连续性验证能力有限。 |

---

## 二、中严重度问题（约 35 个）

### 2.1 边界条件缺失

| 文件 | 行号 | 问题 |
|------|------|------|
| `packages/server/src/domain/dice/evaluator.test.ts` | 234-237 | 仅测试骰值**多于**表达式所需的失败路径，缺少骰值**不足**的边界测试（如 `replayRoll('2d6', [[1]])`）。 |
| `packages/server/src/domain/dice/random.test.ts` | 14-28 | 缺少负数区间、极大值、min>max 错误处理等边界条件测试。 |
| `packages/server/src/domain/rulebook/coc7.test.ts` | 28-50 | 行29-31 已间接覆盖 criticalMax=1 时 roll=1 为大成功，但缺少 roll=2 **不是**大成功的显式断言。 |
| 同上 | 74-96 | 行76-77 已测试默认 fumbleLowSkill=96 边界，但行85-95 房规测试仅验证命中值，未验证自定义阈值的边界另一侧。 |
| 同上 | 111-120 | 幸运检定测试覆盖了成功(60)、失败(61)、大成功(1)，但完全未测试大失败场景（如 roll=100）。 |
| `packages/server/src/domain/session/messages.test.ts` | 104-112 | 没有验证 limit 边界值（如 limit=0、limit=1、limit=超大值）。 |
| 同上 | 114-124 | 没有验证 beforeSeq 超出范围的情况。 |
| 同上 | 126-134 | 没有验证 excludeHidden=false 时暗骰是否可见。 |
| `packages/server/src/domain/session/members.test.ts` | 86-95 | 没有验证保存空数组的情况。 |
| `packages/shared/src/domain.test.ts` | 74-77 | 邀请码测试只验证了长度，未验证字符集。 |
| 同上 | 114-117 | stateBoardVersion 只测试了 0 和 -1，未测试非整数（如 1.5）。 |
| `packages/shared/src/message.test.ts` | 90-119 | visibility 测试中 whisper 只验证了携带 targetId 的情况，未验证 whisper 不携带 targetId 时的行为。 |
| 同上 | 147-153 | subtype 测试只验证了四类合法值被接受，未验证缺少 subtype 时是否被拒绝。 |
| 同上 | 174-177 | hidden 测试只验证了 hidden: true 的情况，未验证缺少 hidden 时是否被拒绝。 |
| 同上 | 210-216 | MessageSchema 判别联合测试只覆盖了 ic 和 dice 两种类型，未测试 ooc/system/narration/state_snapshot。 |

### 2.2 断言不充分

| 文件 | 行号 | 问题 |
|------|------|------|
| `packages/server/src/domain/dice/evaluator.test.ts` | 169 | 使用 `toEqual` 精确匹配整个 check 对象，未来字段扩展会导致测试脆弱。 |
| 同上 | 226-244 | 整个"可复现性"describe 块中 `replayRoll` 仅出现在失败断言中，缺少成功路径验证。 |
| `packages/server/domain/dice/audit.test.ts` | 60 | 时间戳验证仅 `expect(Date.parse(audit.ts)).not.toBeNaN()`，未验证格式、范围或单调性。 |
| 同上 | 52-78 | 首次落账测试在 `toMatchObject` 中未包含 `ts` 字段。 |
| `tests/dice/dice-flow.test.ts` | 185-212 | 明骰测试验证了 hidden/senderId/expr/total/rolls/audit，但未验证 msg 的 roomId、sessionId、timestamp 等字段完整性。 |
| 同上 | 214-229 | 暗骰测试仅验证 hidden=true 和 audit seq 格式，未验证 expr、total、rolls 等内容字段。 |
| 同上 | 275-294 | 审计留痕测试验证了 seq 递增、hidden 标记、actor，但未验证 rollId 字段的存在性或唯一性。 |
| `packages/server/src/gateway/socket.test.ts` | 172-178 | dice:roll 事件测试仅断言 `client.connected` 为 true，未验证是否"暂不处理"。 |
| 同上 | 429-446 | 限速测试仅验证第11条不落盘，未验证前10条是否成功落盘。 |
| `packages/server/src/gateway/socket-ai.test.ts` | 234-263 | 循环上限测试仅验证 dice 长度为 3 和错误包含"上限"，未验证前3个指令块的具体内容或顺序。 |
| `packages/server/src/gateway/http/export.test.ts` | 170-245 | 5000条消息导出测试仅验证状态码、包含"第 5000 句"和耗时，未验证消息总数、顺序、格式正确性。 |
| `packages/server/src/tools/audit-replay.test.ts` | 151-161 | 改判定结果测试使用 `expect(report.mismatches.length).toBeGreaterThan(0)` 弱断言，其他篡改测试使用 `toHaveLength(1)` 精确断言。 |
| `packages/web/src/dice-input.test.ts` | 46-48 | 未知前缀测试只验证了 kind 为 'message'，未验证 content 是否为原始输入。 |
| `packages/web/src/app.test.ts` | 6-10 | 只验证 HTML 包含 APP_NAME 和 PROTOCOL_VERSION 字符串，未验证 HTML 结构。 |

### 2.3 依赖实现细节

| 文件 | 行号 | 问题 |
|------|------|------|
| `packages/server/src/domain/session/ids.test.ts` | 22 | 字母表硬编码 `const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'`。 |
| `packages/server/src/adapters/storage/recovery.test.ts` | 20-27 | roomJson 和 sessionJson 硬编码，schema 改变时测试会失败。 |
| `packages/server/src/gateway/socket.test.ts` | 155 | 依赖错误消息字符串 `/protocol-mismatch/`。 |
| 同上 | 158-163, 165-170 | 依赖 Socket.IO 内部断开原因 `'io server disconnect'`。 |
| 同上 | 555-572 | 假设阶段名称前缀为 'S1'-'S7'，通过 `s.name.slice(0, 2)` 截取前两个字符验证。 |
| `packages/server/src/gateway/socket-ai.test.ts` | 159-206 | 依赖骰式格式 `'1d100<=60'`，断言 `roll.expr` 精确匹配。 |
| `packages/server/src/gateway/http/rooms.test.ts` | 74-79 | 依赖错误消息包含 `'(根)'`。 |
| 同上 | 81-89 | 依赖错误消息包含 `'memberLimit'`。 |
| `packages/server/src/domain/session/sessions.test.ts` | 68 | 直接使用 `JsonStore` 读取 `state.json`，依赖存储实现细节。 |

### 2.4 时间依赖脆弱性

| 文件 | 行号 | 问题 |
|------|------|------|
| `packages/server/src/gateway/socket.test.ts` | 511-531 | `await sleep(300)` 等待消息落盘，系统负载高时可能不够。 |
| `packages/server/src/gateway/socket-ai.test.ts` | 267-298 | `setTimeout(80)` 等待回合启动，系统负载高时可能不够。 |
| `tests/soak/soak.test.ts` | 189 | drain 时间硬编码 800ms，未根据 SOAK_MS 或网络状况动态调整。 |
| `packages/web/src/stores/session.test.ts` | 164-185 | 使用 `vi.waitFor` 等待异步状态变化，依赖时间（默认超时 1000ms，轮询间隔 50ms）。 |

### 2.5 缺少并发测试

| 文件 | 行号 | 问题 |
|------|------|------|
| `packages/server/src/domain/dice/audit.test.ts` | 119-139 | 并发测试验证了 seq 唯一性和落盘顺序，但完全未检查 rollId 唯一性。 |
| `tests/dice/dice-flow.test.ts` | 184-249 | "玩家骰"describe 块包含明骰、暗骰、observer 拒绝三个测试，缺少并发掷骰场景。 |

### 2.6 缺少 fsync/原子性验证

| 文件 | 行号 | 问题 |
|------|------|------|
| `packages/server/src/adapters/storage/jsonl-store.test.ts` | 25-36 | 没有验证 fsync，只验证追加后文件内容正确。 |
| `packages/server/src/adapters/storage/json-store.test.ts` | 25-32 | 没有验证原子性，只验证写入后可读回。 |
| 同上 | 43-51 | 没有验证原子性，只验证覆盖写后读到新内容。 |
| `packages/server/src/domain/session/messages.test.ts` | 82-93 | 没有验证 fsync，只验证追加后可读回。 |

### 2.7 测试绕过正常业务流程

| 文件 | 行号 | 问题 |
|------|------|------|
| `tests/http/rest-contract.test.ts` | 123-128 | `seedMessages` 直接写文件，绕过 API 构造测试数据。 |
| `packages/server/src/gateway/socket.test.ts` | 627-686 | 直接写文件设置世界书，而非通过 API。 |

### 2.8 其他中严重度问题

| 文件 | 行号 | 问题 |
|------|------|------|
| `packages/server/src/domain/dice/evaluator.test.ts` | 65-68 | 除法取整测试 `rollDice('7/2', { random: seq() })` 中 `seq()` 无参数且除法不消耗随机数，属冗余设计。 |
| 同上 | 100-110 | 命运骰测试使用 `seq(-1, 0, 1, 1)` 但未检查 `random.calls`，未验证随机源实际调用次数。 |
| `packages/server/src/domain/dice/random.test.ts` | 42-50 | 不可预测性测试比较两个实例各64次输出，存在理论碰撞概率，非确定性保证。 |
| `packages/server/src/domain/dice/parser.test.ts` | 60-66 | AST 结构验证仅检查了 root/left/right 的 kind 和 op，未验证叶子节点的具体内容。 |
| 同上 | 88-113 | `it.each(illegal)` 仅验证 `toThrow(DiceExpressionError)`，未验证每个 case 的具体错误消息内容。 |
| `packages/server/src/domain/rulebook/coc7.test.ts` | 124,130,136,142,148,154 | 对抗检定测试全部6处使用 `book.adjudicateOpposed?.(...)` 可选链，若方法不存在会静默返回 undefined 导致断言误判。 |
| 同上 | 162,166,170,177,180,190 | 理智损失测试全部6处使用 `book.sanityRule?.(...)` 可选链，同样存在方法缺失时静默通过的风险。 |
| `packages/server/src/domain/session/sessions.test.ts` | 110 | 对随机 id 排序后比较，断言过于宽松。 |
| 同上 | 144-153 | 重复 end 幂等只验证 endedAt 不变，没有验证返回值的其他字段。 |
| `packages/server/src/domain/session/rooms.test.ts` | 61 | 只验证 inviteCode 长度，没有验证字符集。 |
| 同上 | 62 | 只验证 hostToken 长度大于 0，没有验证具体长度或字符集。 |
| 同上 | 108-117 | 没有验证损坏房间是否产生告警。 |
| `packages/server/src/domain/session/members.test.ts` | 64-76 | 只验证 joinedAt 是有效 ISO 时间，没有验证时间是否在创建时刻附近。 |
| 同上 | 48-60 | 没有验证坏条目是否产生告警。 |
| `packages/server/src/adapters/storage/recovery.test.ts` | 80-92 | 只验证 id 和 messageCount，没有验证恢复后的数据是否与原始数据完全一致。 |
| `packages/server/src/adapters/storage/crash-recovery.test.ts` | 62, 95-98 | 依赖环境变量 `AIDLE_TEST_CRASH_AT` 和 `AIDLE_TEST_CRASH_PHASE`。 |
| 同上 | 19-22 | 依赖外部脚本 `tests/crash/append-harness.mjs`。 |
| `packages/server/src/gateway/socket-ai.test.ts` | 330-351 | 验证了 narrations 内容顺序，但未验证 deltas 顺序或 msgs 整体顺序。 |
| `packages/server/src/gateway/http/cards.test.ts` | 64-76 | 依赖 `writeCardToPng` 函数生成 PNG 卡数据。 |
| `packages/shared/src/message.test.ts` | 43-47 | 六类消息测试只传了 `{ type }`，验证缺少 seq/ts/sessionId 时拒绝。 |
| 同上 | 49-69 | seq 测试只用了 IcMsgSchema，未覆盖其他五类消息的 seq 约束。 |
| 同上 | 121-131 | 非法 visibility 只测了 'kp' 一种，未测试其他非法值。 |
| 同上 | 164-168 | DiceMsg 的 roll 对象在文件顶部硬编码，测试中直接使用该常量。 |
| `packages/shared/src/errors.test.ts` | 31-34 | 只测试了合法载荷被接受，未验证额外字段是否被拒绝。 |
| 同上 | 62-72 | E-SRV-01 直接测试（无 skipIf），E-MOD-01 使用 `describe.skipIf` 条件跳过，处理方式不一致。 |
| `packages/web/src/stores/session.test.ts` | 140-151 | 断线重连测试直接设置 `store.memberId` 和 `store.maxSeq`，而非通过正常 join 流程设置。 |
| `tests/golden/golden.test.ts` | 32 | `toHaveLength(1)` 假设单字段差异只返回1条记录，依赖具体实现。 |
| 同上 | 38 | 只检查 `length > 0`，未验证差异内容是否正确描述缺失字段。 |
| 同上 | 26-38 | 缺少边界条件测试：空对象、嵌套对象差异、数组长度不同、多处差异等场景。 |
| `tests/soak/soak.test.ts` | 220 | socket.close() 在测试末尾，若前面断言失败抛异常，socket 不会被关闭。 |
| 同上 | 144-160 | session:start 的 Promise 无超时机制，若服务器不响应会永久挂起。 |
| `tests/bench/nfr05-bench.test.ts` | 118-123 | p95 函数定义后，文件中没有针对该函数的单元测试用例。 |

---

## 三、低严重度问题（约 20 个）

| 文件 | 行号 | 问题 |
|------|------|------|
| `packages/server/src/domain/dice/audit.test.ts` | 108-117 | rollId 唯一性测试循环仅5个样本，样本量偏小。 |
| `packages/server/src/domain/dice/parser.test.ts` | 68-70 | 括号测试仅验证"v1 不支持"（期望抛异常），无嵌套场景。 |
| `packages/server/src/domain/session/sessions.test.ts` | 112-113 | localeCompare 对 ISO 时间字符串排序，同毫秒创建时无法区分。 |
| 同上 | 161-173 | 两个独立断言合并在一个 it 中，降低测试独立性。 |
| `packages/server/src/domain/session/rooms.test.ts` | 129-140 | 重置邀请码测试没有验证新码字符集。 |
| `packages/server/src/domain/session/messages.test.ts` | 136-145 | 没有验证坏行是否产生告警。 |
| `packages/server/src/domain/session/members.test.ts` | 102-115 | 12 人同时进房只验证成员数量，没有验证并发添加时的顺序或时间戳。 |
| `packages/server/src/domain/session/ids.test.ts` | 39-42 | 只验证 generateRoomId 唯一性，未验证其他 ID 生成器唯一性。 |
| `packages/server/src/adapters/storage/jsonl-store.test.ts` | 49-61 | 没有验证并发追加时的顺序保证。 |
| 同上 | 74-85 | 500 条连续追加只验证功能正确性，没有验证内存使用或文件描述符释放。 |
| `packages/server/src/adapters/storage/json-store.test.ts` | 53-59 | 依赖临时文件命名，只验证目录内不残留临时文件。 |
| 同上 | 81-93 | 并发写 50 次只验证结果在 0-49 范围内，没有验证结果是某一次的完整值。 |
| `packages/server/src/gateway/socket.test.ts` | 265-276 | 房间满员测试未验证满员后第一个连接是否仍然正常。 |
| 同上 | 352-373 | seq 起始值假设，未验证 seq 起始值。 |
| `packages/server/src/gateway/http/rooms.test.ts` | 216-237 | 使用 `as unknown as Message` 类型断言构造 dice 消息。 |
| `packages/server/src/gateway/http/export.test.ts` | 102-109 | afterAll 不清理临时目录。 |
| `packages/server/src/gateway/http/cards.test.ts` | 121-127 | 假设按文件名排序。 |
| `packages/server/src/gateway/socket-ai.test.ts` | 210-230 | 防篡改测试只验证错误码 E-AI-01，未验证错误消息内容。 |
| `packages/shared/src/index.test.ts` | 18-21 | 行14-16 的 `toEqual` 已隐含唯一性验证，行18-21 的 `new Set().size` 检查是冗余的。 |
| `packages/shared/src/errors.test.ts` | 13-17 | 测试验证了六个基础错误码存在，但没有验证是否只有这六个。 |
| `packages/shared/src/message.test.ts` | 133-143 | whisper 允许携带 targetId，但没有验证 targetId 的格式约束。 |
| 同上 | 181-189 | NarrationMsg 的 streaming 测试只验证了 streaming: true。 |
| 同上 | 199-207 | SnapshotMsg 测试只验证了 version 字段。 |
| 同上 | 223-227 | type 与实际字段不匹配测试只测了 dice 伪装。 |
| `packages/shared/src/domain.test.ts` | 70-72 | RoomSchema 测试只验证了 id 和 memberLimit。 |
| 同上 | 86-89 | activeSessionId 测试未验证空字符串是否被拒绝。 |
| 同上 | 93-95 | SessionSchema 测试只验证了 id 和 roomId。 |
| 同上 | 119-121 | endedAt 测试只验证了 null 被接受。 |
| 同上 | 146-150 | StateBoardSchema 测试只验证了 version 和 pcs。 |
| 同上 | 176-178 | PCSheetSchema 测试只验证了 playerName 和 luck。 |
| 同上 | 208-211 | CharacterCardV3Schema 测试只验证了 spec。 |
| `tests/architecture/dependency-direction.test.ts` | 45 | 正则未排除注释行，注释中包含 import 格式的文本会被误判。 |
| 同上 | 32 | 测试文件排除逻辑 `!entry.name.endsWith('.test.ts')` 可能误排除非测试文件。 |
| `tests/soak/soak.test.ts` | 192 | 只检查 `error:app` 事件，其他类型错误无法发现。 |
| 同上 | 210-218 | RSS 均值比较方式脆弱，启动阶段有内存峰值时增长量被低估。 |
| 同上 | 100 | 就绪轮询 deadline 硬编码 30s，慢速 CI 可能不够。 |
| `tests/bench/nfr05-bench.test.ts` | 167 | 管线预热仅10次，对于 S1-S7 复杂管线可能不足以让 JIT 充分预热。 |
| 同上 | 51 | 类型断言 `as` 隐藏潜在错误。 |
| `tests/golden/golden.test.ts` | 9 | `loadGoldenCases` 失败导致整个套件崩溃，无法定位具体哪个用例文件有问题。 |
| 同上 | 19-20 | 冗余断言：`expect(result.diffs).toEqual([])` 和 `expect(result.ok).toBe(true)` 存在冗余。 |

---

## 四、复核修正项

以下问题经复核后描述需要修正：

| 文件 | 原描述 | 修正后描述 |
|------|--------|------------|
| `packages/server/src/domain/dice/parser.test.ts:68-70` | 括号测试仅覆盖单层 | 该测试验证的是"括号 v1 不支持"（期望抛异常），而非"括号解析仅覆盖单层" |
| `packages/server/src/domain/rulebook/coc7.test.ts:28-50` | 大成功测试未验证 criticalMax 边界值 1 | 行29-31 已间接覆盖 criticalMax=1 时 roll=1 为大成功，但缺少 roll=2 不是大成功的显式断言 |
| `packages/server/src/domain/rulebook/coc7.test.ts:74-96` | 大失败测试未验证 fumbleLowSkill 边界 | 行76-77 已测试默认阈值 96 的边界，但行85-95 房规测试仅验证命中值，未验证自定义阈值的边界另一侧 |
| `tests/dice/dice-flow.test.ts:251-272` | 非法骰式测试未验证审计文件不存在 | **不确认** — 行268-270 明确使用 `rejects.toThrow()` 验证了审计文件不存在，原描述与实际代码相反 |
| `packages/shared/src/errors.test.ts:44-48` | 重复覆盖 | 该测试与行13-17 目的不同（验证 Schema 接受性 vs 验证码存在），但若 ERROR_CODES 仅含六个基础码则覆盖范围完全重叠 |
| `tests/soak/soak.test.ts:174` | 30分钟 soak 消息数量严重不足 | 30分钟 soak 时 interval=3500ms，每客户端约514条，3端共约1542条。"严重不足"是主观判断，但消息密度确实偏低 |
| `tests/bench/nfr05-bench.test.ts:167` | 管线预热次数可能不足 | 管线预热仅10次，对于 S1-S7 复杂管线可能不足以让 JIT 充分预热，但"可能不足"是主观判断 |

---

## 五、与 SDD/TDD 设计文档的冲突

| 文件 | 冲突条款 | 问题 |
|------|----------|------|
| `packages/server/src/adapters/storage/jsonl-store.test.ts` | TDD §6: WAP — msg:send 先 fsync 追加 JSONL 再广播 | 没有验证 fsync，无法保证 NFR-06 "消息 0 丢失" 的核心承诺 |
| `packages/server/src/adapters/storage/json-store.test.ts` | TDD §6: 原子写 — write-tmp → rename 模式 | 没有验证原子性，无法保证 NFR-06 的核心承诺 |
| `packages/server/src/domain/session/messages.test.ts` | TDD §6: WAP — msg:send 先 fsync 追加 JSONL 再广播 | 没有验证 fsync，无法保证 NFR-06 的核心承诺 |
| `tests/dice/dice-flow.test.ts` | TDD §5.3: 写顺序不变式 — 先落审计（fsync）再广播，没有审计号的骰子不得进入消息流 | 审计留痕测试未验证 rollId 字段的存在性，无法保证"没有审计号的骰子不得进入消息流"的不变式 |
| `packages/server/src/domain/rulebook/coc7.test.ts` | TDD §5.3: COC7 判定表逐条覆盖 | 缺少幸运检定大失败测试，判定表覆盖不完整 |
| `packages/server/src/domain/rulebook/coc7.test.ts` | TDD §5.3: 房规配置测试 | 房规测试仅验证命中值，未验证自定义阈值的边界另一侧 |
| `packages/server/src/tools/audit-replay.test.ts` | TDD §5.3: 复现校验器 — 逐条重算，不一致即报 | 改判定结果测试使用弱断言 `expect(report.mismatches.length).toBeGreaterThan(0)`，无法保证复现验证的准确性 |
| `tests/soak/soak.test.ts` | TDD §10: 并发 — 3 端 30 分钟压测 | 30 分钟 soak 消息密度偏低，seq 连续性验证能力有限 |
| `packages/server/src/domain/dice/audit.test.ts` | TDD §5.3: 审计流水 — seq 全局单调（零填充 6 位，重启从文件尾部恢复续写） | 并发测试未验证 rollId 唯一性，无法保证审计流水的完整性 |
| 状态板乐观锁冲突路径测试 | TDD §10: 并发 — 状态板乐观锁冲突路径 | **可能缺失** — 审核报告中未发现状态板乐观锁冲突路径的测试 |
| `tests/statistical/chi-square.test.ts` | TDD §10: 骰子引擎 — χ² 均匀性检验（10⁶ 次，p>0.01） | 样本量可通过环境变量缩小，且从 dist/ 导入，无法保证检验力度 |

---

## 六、与 CODING_STANDARDS.md 的冲突

| 文件 | 冲突条款 | 问题 |
|------|----------|------|
| `tests/statistical/chi-square.test.ts` | §2.5 测试与源码同目录 | 从 `dist/` 导入，且位于 `tests/statistical/` 而非源码同目录 |
| `tests/bench/nfr05-bench.test.ts` | §2.5 测试与源码同目录 | 从 `dist/` 导入 |
| `tests/` 目录下所有测试 | §2.5 测试与源码同目录 | 测试与源码不同目录 |
| `packages/shared/src/errors.test.ts` | §2.5 测试覆盖率 | `describe.skipIf` 导致覆盖率统计不准确 |
| `packages/server/src/adapters/llm/llm-adapters.test.ts` | §1.4 目标驱动 | 条件断言违反"测试应该有明确的成功标准" |
| `packages/server/src/gateway/http/rooms.test.ts` | §2.1 类型安全 | `as unknown as Message` 类型断言掩盖错误 |
| 多个文件 | §2.6 控制台输出 | 多个测试没有验证告警或日志（`console.warn`） |
| `packages/server/src/adapters/storage/jsonl-store.test.ts` | §2.3 持久化 | 没有充分验证原子写入和 fsync 的行为契约 |
| `packages/server/src/adapters/storage/json-store.test.ts` | §2.3 持久化 | 没有充分验证原子写入和 fsync 的行为契约 |

---

## 七、总结

| 严重程度 | 数量 | 关键问题 |
|----------|------|----------|
| 高 | 8 | dist/ 导入、架构守护缺陷、测试永不执行、条件断言假通过、mock 实现细节、soak 消息量不足 |
| 中 | 约 35 | 边界条件缺失、断言不充分、依赖实现细节、时间依赖脆弱性、缺少并发测试、缺少 fsync/原子性验证 |
| 低 | 约 20 | 样本量不足、重复覆盖、测试独立性差、冗余断言 |

**最需要优先修复的问题：**
1. `dependency-direction.test.ts` 的多行 import 漏检和相对路径绕过 — 架构守护测试的核心功能缺陷，违反 TDD §1.2 依赖方向约束
2. `chi-square.test.ts` 和 `nfr05-bench.test.ts` 从 `dist/` 导入 — 违反测试规范
3. `protocol.test.ts` 和 `rest-contract.test.ts` 的 `describe.skip` — 测试可能永不执行，违反 TDD §4 通信协议契约
4. `errors.test.ts` 的 `describe.skipIf` — 错误码被移除时静默跳过，违反 TDD §11 错误处理契约
5. `llm-adapters.test.ts` 的条件断言 — 测试可能假通过
6. `socket.test.ts` 的 `vi.spyOn(JsonlStore.prototype, 'append')` — 依赖实现细节

**基于 SDD/TDD 文档的新增发现：**
1. `dice-flow.test.ts` 未验证 TDD §5.3 "没有审计号的骰子不得进入消息流" 不变式
2. `coc7.test.ts` 缺少 TDD §5.3 要求的"COC7 判定表逐条"完整覆盖
3. `messages.test.ts` 和 `jsonl-store.test.ts` 未验证 TDD §6 要求的 WAP（写前持久化）fsync 行为
4. 状态板乐观锁冲突路径测试可能缺失，违反 TDD §10 并发测试要求
