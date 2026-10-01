# 测试审查报告核实结论与修正计划

> 核实日期：2026-09-27
> 核实对象：`tests/TEST-REVIEW-2026-09-27.md`
> 核实方式：逐文件读源码比对（非推断），并用脚本实测了架构守护的实际漏检面
> 结论：**报告整体可信，行号与描述准确率高（抽检 20+ 条全部对得上）**；但有 3 处定性偏重、4 处事实性遗漏、4 处计数/路径错误需订正后再作为行动计划执行。

---

## 一、核实总览

| 维度 | 核实结果 |
|------|----------|
| 引用的文件 / 行号 | ✅ 准确率极高。抽检 20+ 条中低严重度条目，行号与描述**全部一致** |
| §一 高严重度（声称 8 个） | ⚠️ 实际编号条目 6 个、表格行 11 行；其中 **3 条应降级**、**2 条已过时** |
| §二 中严重度（声称"约 35"） | ⚠️ 实际表格行 **82** 行，计数偏低一半以上 |
| §三 低严重度（声称"约 20"） | ⚠️ 实际表格行 **40** 行，同样偏低 |
| 审查范围（声称"约 50 个测试文件"） | ❌ 实际 **60** 个；有 **15 个文件完全未被审查** |
| §四 自查纠错项 | ✅ 有效（dice-flow 那条"不确认"的自我纠正确属实，见下文） |

**一句话：这份报告作为"问题清单"质量很好，作为"行动计划"必须先订正——它的定性偏重会把力气花在不该花的地方，而真正的漏网者是那些没被扫到的 15 个文件。**

---

## 二、确认属实、应当保留的问题

### H-1 架构守护的多行 import 漏检（真正的高危，已实测实锤）

报告说正则 `/^\s*(import|export)\b.*from\s+['"]/` 匹配不到多行 import。我用脚本实扫了四个受检目录的 **42 个源文件**：

```
含 import/export-from 的文件：37 个
被守卫完全跳过的文件：       9 个
```

漏网清单（`多行 import 总数 / 被逐行正则命中数`）：

| 文件 | 总数 | 命中 |
|------|------|------|
| `domain/character/import.ts` | 2 | 1 |
| `domain/character/library.ts` | 6 | 5 |
| `domain/rulebook/coc7.ts` | 3 | 2 |
| `domain/rulebook/types.ts` | 2 | 1 |
| `domain/session/sessions.ts` | 7 | 6 |
| `pipeline/pipeline.ts` | 3 | 2 |
| `pipeline/types.ts` | 3 | 2 |
| `shared/src/protocol.ts` | 4 | 3 |
| `web/src/stores/session.ts` | 3 | 2 |

**补充核实（报告没提）**：好消息——我逐条看了这 9 个文件的漏网 import，目标分别是 `@behindveil/shared`、`./stages.js`、`./domain.js` 等，**目前无一违反 TDD §1.2**（multi-line 部分没有指向 gateway / adapters 的）。也就是说：**守护现在是失效的，但暂时没漏到真违规**。属于"防盗门坏了、家里还没被偷"，必须修，但不用当成线上事故。

### H-2 相对路径可绕过跨包检测

属实（第 77、88 行只查 `@behindveil/(server|web)` 包名）。
**补充核实**：我 grep 了 `packages/{server,shared,web}/src` 下所有非测试文件，跨包相对引用命中数为 **0**。所以同样是"潜在漏洞、当前无实际逃逸"。

### H-3 空 import 文件导致 `expect` 不执行

属实。Vitest 默认不强制"用例至少有一条断言"，文件无 import 时内层循环不跑，测试静默通过。修法是加 `expect.hasAssertions()`。

### H-4 Soak 消息密度

算术属实：`1,800,000ms / clamp(…) = 3500ms` → 每端约 514 条、3 端约 1542 条。30 分钟只跑 1500 条消息去验 seq 连续性，确实偏稀。

### 中低严重度条目

抽检了 `index.test.ts:18-21`、`domain.test.ts:74-77 / 114-117`、`app.test.ts:6-10`、`dice-input.test.ts:46-48`、`evaluator.test.ts:228-246`、`random.test.ts:10-32`、`messages.test.ts:100-140` —— **行号、描述、缺漏判断全部准确**，这部分可以照单执行。

### §四 自查项复核结论

报告把它先前对 `dice-flow.test.ts:251-272` 的判断标为"不确认"是对的。原文 268-270 行确有：

```ts
await expect(readFile(path.join(h.dataDir, 'logs', 'audit-dice.jsonl'), 'utf8')).rejects.toThrow();
```

明确验证了"非法骰式不产生审计流水"，先前描述确实反了。这一轮的自查机制有效。

---

## 三、需要降级 / 修正定性（否则会做无用功）

### ▼ X-1 `protocol.test.ts` / `rest-contract.test.ts` 的 `describe.skip`——**已过时，且报告抓错了重点**

报告说"可能永远不会被执行"。实测：

- `packages/shared/src/protocol.ts` **已落地**，`packages/shared/dist/protocol.js` **已构建** → `protocol` 非 null → `suite === describe`（**正在执行**）
- 路由已落地 → `rest-contract` 的 `enabled` 大概率为 `true`（**正在执行**）

这两处的 `skip` 是"契约先行"阶段的临时胶布，如今契约已到，**胶布该撕了**（见 P0-2）。

**但报告漏掉了真正的问题**：这两个文件本身也**从 dist 导入**（`protocol.test.ts:14-15` → `packages/shared/dist/protocol.js`；`rest-contract.test.ts:22` → `packages/server/dist/index.js`）。所以 dist 依赖不是"2 个文件"，是 **4 个**。且它们的降级方式是 `await import(...).catch(() => null)`——**dist 缺失不会报错，只会静默整组跳过**。这才是"可能永不执行"的真实机制，报告因果写反了。

### ▼ X-2 dist 导入的严重性被高估

属实，但：项目的正式命令是 `pnpm test` = `pnpm build && vitest run`（`test:coverage` 同理），**测试前必先构建**，`pnpm verify` 的顺序也是 `format → lint → build → typecheck → test:coverage`。所以在 CI 和常规本地流程里 dist 始终是新鲜的。真正的影响面只有"单独敲 `vitest run`"这一种场景。

另外：**§六 说 "tests/ 目录下所有测试违反 CODING_STANDARDS §2.5" 不成立**。根 `vitest.config.ts` 第 8 行写着「跨包集成载体：tests/（黄金用例、架构约束、崩溃夹具）」，`tests/vitest.config.ts` 也注释「跨包里程碑的集成载体」——`tests/` 是**官方设计的跨包集成层**，不是违规。包内单元测试与源码同目录这条已经做到了（shared/server/web 全部 `src/**/*.test.ts`）。

> 顺带订正引用精度：§2.5 的小标题是《测试覆盖率》，"测试与源码同目录"是该条最后一句，不是条目名。

### ▼ X-3 `errors.test.ts` 的 `describe.skipIf(!hasModCode)`

确认 `packages/shared/src/errors.ts:16` 有 `'E-MOD-01'` → `hasModCode === true` → **该 describe 正在执行，没有跳过**。报告的担心（"错误码被移除时静默跳过"）是个成立的防御性顾虑，但不是现行缺陷。降级 **低**，处理方式同 X-1：撕胶布。

### ▼ X-4 `llm-adapters.test.ts:208-231` 条件断言

代码属实，但定性错了。这不是"假通过"：

```ts
if (outcome.resolved) {
  expect(outcome.res.aborted).toBe(true);
  expect('你好'.startsWith(outcome.res.content)).toBe(true);
} else {
  expect(outcome.err).toMatchObject({ code: 'E-LLM-01' });
}
```

**两个分支都有实质断言**，无论走哪支都验证了"硬 RST 不抛出未捕获异常"。真实问题只是"非确定性——某一天某一支可能永远跑不到，造成覆盖率空洞"。这是技术债，不是缺陷。**降级 低**，建议只加注释 + `expect.hasAssertions()`，不要为了确定性去改造 SSE mock（那是过度设计，违反 CODING_STANDARDS §1.2）。

### ▼ X-5 `socket.test.ts:448-469` 的 `vi.spyOn(JsonlStore.prototype, 'append')`

这是**模拟磁盘写满**的唯一合理注入点——WAP（先落盘后广播）契约本身就架在 `append` 上。换实现会失败不是缺点，是它该有的灵敏度。**建议判定为非问题**，报告不该列为高严重度。

### ▼ X-6 §2.6 / §五 的 "未验证 fsync → 无法保证 NFR-06"

**实现层面 fsync 是有的**：`jsonl-store.ts:30` 的 `await handle.sync()`、`json-store.ts:71` 的 `await handle.sync()`，且 `json-store.ts` 已用「路径串行队列 + 唯一后缀 tmp + fsync → rename」修掉了 2026-09-25 代码审查发现的并发损坏（见该文件第 6-30 行的注释）。

所以这不是"NFR-06 没有保证"，而是"**这条保证没有被回归测试锁住**"——改坏了不会有人报警。降级 **中**，但仍值得做（见 P1-3）。

另外，报告**漏看了 `json-store.test.ts:76-124` 整段`JsonStore 并发安全`describe**：里面已有并发写 50 次、`update` 并发 20 次不丢更新（严格 `toEqual({ n: 20 })`）、update/write 交错串行三项回归用例。报告 §2.6 说它"没有验证原子性"、§三说它"并发写 50 次只验证结果在 0-49 范围内"——**评价偏颇**。50 次并发里 `JSON.parse` 能成功且 version 落在 0-49，本身已经证明了"结果是某一次的完整值"（撕裂写会导致解析失败或值越界），再叠加第 92 行"目录内不残留临时文件"，这个用例是够用的。

### ▼ X-7 §五 "状态板乐观锁冲突路径测试可能缺失"——归因错误

我把 `expectedVersion` / `乐观锁` / `versionMismatch` 在整个 `packages/server/src` 非测试代码里 grep，**零命中**。契约层（`shared/src/protocol.ts` 的 `StateUpdateSchema.expectedVersion`）已定，但**实现本身还没落地**——按记忆里的进度，状态板属于 M5，被 M3/M4 门禁挡着没开工。

**没有实现 ⇒ 当然没有测试**。这不是测试缺陷，把它写进修正计划会导致"对着空气写测试"，直接违反里程碑纪律。应移出计划。

---

## 四、报告自身的错漏（需先订正）

| 类别 | 位置 | 问题 |
|------|------|------|
| 路径错误 | §2.2 第 3、4 行 | `packages/server/domain/dice/audit.test.ts` 漏了 `src/`，应为 `packages/server/src/domain/dice/audit.test.ts` |
| 计数不符 | §一 / §二 / §三 标题 | 声称 8 / 约35 / 约20，实际表格行 11 / 82 / 40 |
| 范围不符 | §前言 | "约 50 个测试文件"，实际 **60 个** |
| 遗漏 dist 导入 | §一 第 1 项 | 只列了 `chi-square` 和 `nfr05-bench`，漏了 `tests/protocol/protocol.test.ts`、`tests/http/rest-contract.test.ts` |
| 遗漏审查对象 | 全文 | 以下 **15 个测试文件完全未被审查**：`domain/ai-directive/`（6 个：degrade / executor / loop / repair / scan / validate）、`observability/`（2 个：preview / redact）、`pipeline/`（2 个）、`adapters/export/`（2 个）、`web/src/` 另 2 个、`tests/e2e/f03-directive-regression.test.ts`、`tests/crash/`、`domain/stateboard/roster.stub.test.ts` |

> **最该警惕的是 `domain/ai-directive/` 那 6 个文件一个都没审。** 按 CODING_STANDARDS §2.2，AI 指令块的解析与校验正是"叙事交给 LLM、规则交给代码"这条核心不变式的闸门，也是 §2.5 点名要求 100% 覆盖的区域。报告绕开了它。

---

## 五、修正计划

分四级。**建议严格按 P0 → P1 顺序做，做完一轮门禁全绿再考虑 P2**，P3 可以并行安排给别人扫。

### P0 — 守护失效与降级开关（做完这四条，报告里唯一"真高危"就解决了）

| # | 动作 | 涉及文件 | 验收标准 |
|---|------|----------|----------|
| P0-1 | 重写 `importLines`：改用**全文正则**（`/^\s*(?:import\|export)\b[\s\S]*?from\s+['"]([^'"]+)['"]/gm`）取到模块说明符，而不是逐行过滤；断言对象从"整行字符串"改为"解析出的说明符"，并同时拦截包名（`@behindveil/x`）与相对路径（`../../server/src/...`）两种写法 | `tests/architecture/dependency-direction.test.ts` | 脚本复扫那 9 个文件，漏检数应为 **0**；另临时插入一条多行 domain→gateway import，测试必须 FAIL（反向验证守护真的生效） |
| P0-2 | 每个守卫用例开头加 `expect.hasAssertions()`，杜绝"无 import ⇒ 无断言 ⇒ 静默通过" | 同上 | 对空临时目录跑一次，用例应 FAIL 而非 pass |
| P0-3 | 撕掉三处"契约先行"胶布：`protocol.test.ts:33` 的 `protocol ? describe : describe.skip`、`rest-contract.test.ts:90` 的 `enabled ? describe : describe.skip`、`errors.test.ts:53` 的 `describe.skipIf(!hasModCode)`——契约均已落地，一律改为无条件 `describe` | `tests/protocol/protocol.test.ts`、`tests/http/rest-contract.test.ts`、`packages/shared/src/errors.test.ts` | `vitest run` 报告中这三个套件均显示**已执行**（不是 ↓skipped）；`errors.test.ts` 覆盖率不再被 skip 影响 |
| P0-4 | 4 个 dist 导入改为源码导入；若 vite 对 `.js`→`.ts` 的解析不通，退而保留 dist，但把 `catch(() => null)` 改成**显式 fail**（dist 缺失/过期不再是静默降级） | `tests/statistical/chi-square.test.ts`、`tests/bench/nfr05-bench.test.ts`、`tests/protocol/protocol.test.ts`、`tests/http/rest-contract.test.ts` | 删掉 `packages/*/dist` 后跑测试：改源码导入的两个必须仍能跑通；另两个必须**明确报错**而不是 skip |

> P0-1/P0-2 是一份文件内部的改动，**半天能闭环，收益最高**，建议第一个做。

### P1 — 把核心不变式锁进回归测试

| # | 动作 | 涉及文件 | 验收标准 |
|---|------|----------|----------|
| P1-1 | COC7 判定表补齐：幸运检定补 `roll=100`（大失败）；房规测试补"自定义阈值边界另一侧"（如 `fumbleLowSkill=90` 时 roll=89 不算大失败）；补 `roll=2` 不是大成功的显式断言 | `packages/server/src/domain/rulebook/coc7.test.ts` | 该文件的 **分支覆盖率达 100%**（§2.5 对判定类代码的硬要求） |
| P1-2 | 审计不变式加锁：① 并发用例断言 `rollId` 20 个互不相同（现只验了 seq）；② dice-flow 暗骰用例补验 `expr / total / rolls` 内容字段与 `rollId` 存在性；③ audit-replay 的"改判定结果"从弱断言 `>0` 改成 `toHaveLength(1)` 且指向具体字段 | `domain/dice/audit.test.ts`、`tests/dice/dice-flow.test.ts`、`server/src/tools/audit-replay.test.ts` | 三条都能手工破坏实现后立刻 FAIL（反向验证） |
| P1-3 | 给 WAP 加 fsync 回归锁：用 spy 断言 `JsonlStore.append` 确实调用了底层 `sync()`（现在是 READ=已落盘，但没人证明是 fsync 的功劳）；`JsonStore` 同理 | `adapters/storage/jsonl-store.test.ts`、`json-store.test.ts`、`domain/session/messages.test.ts` | mock 掉 `sync` 使其变成 no-op 后，测试必须 FAIL |
| P1-4 | `evaluator.test.ts` 补"骰值不足"的对称路径（`replayRoll('2d6', [[1]])`），并把 SQL-式的 `toEqual` 整个 check 对象改成 `toMatchObject` 只断言关心的字段 | `packages/server/src/domain/dice/evaluator.test.ts` | 未来给 check 加字段时测试不再假失败 |

### P2 — 契约层与薄弱断言补强（量大、收益递减，可酌情挑选）

优先级从高到低：

1. **shared Schema 判别联合补全**：`MessageSchema` 现在只测了 `ic`/`dice`，补 `ooc / system / narration / state_snapshot`；补"缺 `subtype`/`hidden` 时是否被拒绝"、"whisper 不携带 targetId"（`packages/shared/src/message.test.ts`）
2. **邀请码 / ID 字符集**：不只是验长度，要验字符集合法性（`shared/src/domain.test.ts:74-77`、`server/src/domain/session/rooms.test.ts:61-62`、重置邀请码:129-140）
3. **边界值补测**：`limit=0/1/超大`、`beforeSeq` 越界、`excludeHidden=false` 时暗骰应可见、`stateBoardVersion` 非整数（`domain/session/messages.test.ts`、`shared/src/domain.test.ts`）
4. **`rest-contract` 5000 条导出用例**：从"状态码 + 含第 5000 句"升级为校验总数与顺序（`gateway/http/export.test.ts:170-245`）
5. **`socket.test.ts` 限速用例**：补验前 10 条确实成功落盘（现只验第 11 条没落盘）

**建议：P2 只做第 1、2 组**（契约层，错了会串到前后端），第 3-5 组看心情，价值有限。

### P3 — 补扫报告完全遗漏的 15 个文件

必须扫的（涉及核心不变式）：

1. `packages/server/src/domain/ai-directive/` 全部 6 个（`degrade` / `executor` / `loop` / `repair` / `scan` / `validate`）——AI 指令块解析是"不能让 LLM 自己产生数值"这条铁律的第一道闸门
2. `packages/server/src/observability/redact.test.ts`——涉及 hostToken 等凭据脱敏，泄露面直接相关
3. `tests/e2e/f03-directive-regression.test.ts`——50 轮回归，解析成功率 ≥95% 的口径是否真的被执行

其余（`pipeline/`、`adapters/export/`、`crash/`、`stateboard/roster.stub.test.ts`）同步补一遍即可。

### 建议执行顺序

```
P0-1 + P0-2  →  跑 vitest验证守护反向生效  →  P0-3 + P0-4  →  全绿后第一轮收尾
    ↓
P1-1 ~ P1-4  →  反向验证三组断言确实会 FAIL  →  P3 并行
    ↓
P2 酌情挑选
```

> P2/P3 完成后建议重算一次覆盖率：若 §2.5 要求的"数值/判定类 100%"仍未达标，应优先用 P3 的 `ai-directive` 补测来追，而不是给低价值用例注水。
