import type {
  CheckGrade,
  CheckOutcome,
  ErrorCode,
  RollCheck,
  StateBoard,
} from '@behindveil/shared';
import { describe, expect, it } from 'vitest';
import type { ParsedRoll } from '../dice/evaluator.js';
import type { RandomSource } from '../dice/random.js';
import { LlmError, type LlmAdapter, type LlmMessage } from '../llm.js';
import { DirectiveSuccessTracker } from './degrade.js';
import type { PcRoster } from './executor.js';
import {
  directiveResultText,
  hpResultText,
  FEW_SHOT_EXAMPLES,
  MAX_CHECKS_PER_TURN,
  NO_MORE_CHECKS_META,
  runAiTurn,
  sanityResultText,
  type AiTurnPorts,
} from './loop.js';
import { hpPatch, sanityLossPatch } from '../stateboard/engine-writes.js';
import { applyStatePatch } from '../stateboard/board.js';
import { rollDice } from '../dice/evaluator.js';
import { Coc7RuleBook } from '../rulebook/coc7.js';
import type { CheckDirective } from './schema.js';
import type { DirectiveScanEvent } from './scan.js';

/**
 * T-M3-04/05：闭环编排器（TDD §5.4 处理循环 / ADR-02）。
 *
 * 覆盖主线：流式增量广播 → 指令块 → 服务端掷骰 → 回注 → 续写；
 * 以及两条护栏：检定循环上限（TC-FR-05-006/007）与二级降级（TDD §5.4 降级链）。
 * 端口全注入桩件，领域层不碰 gateway / 定时器。
 */

/** 固定随机源：int 恒返回 n（1d100 场景即骰值 n） */
const fixed = (n: number): RandomSource => ({ int: () => n });

const rosterOf = (value: number): PcRoster => ({
  skillValue: () => ({ found: true, value, name: '爱丽丝' }),
});

const fence = (json: string): string => `\`\`\`aidle\n${json}\n\`\`\`\n`;

const checkJson = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    op: 'check',
    target: 'pc:alice',
    skill: '侦查',
    difficulty: 'normal',
    label: '翻查书桌',
    ...over,
  });

/** 一次 LLM 请求的编排：分块增量、（可选）中断、或直接抛错 */
interface ScriptedReply {
  chunks?: string[];
  aborted?: boolean;
  error?: Error;
}

interface Harness {
  ports: AiTurnPorts;
  /** 每次请求的入参快照（注入的 system 元指令可见） */
  calls: { messages: LlmMessage[] }[];
  dice: ParsedRoll[];
  results: string[];
  alerts: { code: ErrorCode; message: string }[];
  deltas: string[];
  narrations: { triggerSeq: number; content: string; aborted: boolean }[];
  fallbacks: number;
  tracker: DirectiveSuccessTracker;
  /** 留档端口收到的失败块（T-M3-07，测试文档 §12.4） */
  records: DirectiveScanEvent[];
  /** 引擎写路径应用记录（T-M8-03/04 数值效果，网关队列语义的模拟） */
  hpEffects: Array<{
    key: string;
    kind: 'damage' | 'heal';
    roll: ParsedRoll;
    before: number;
    after: number;
  }>;
  sanityEffects: Array<{
    key: string;
    sanRoll: number;
    lossRoll: ParsedRoll;
    loss: number;
    before: number;
    after: number;
  }>;
}

function harness(
  replies: ScriptedReply[],
  over: Partial<AiTurnPorts> = {},
  opts: { board?: StateBoard } = {},
): Harness {
  const tracker = over.tracker ?? new DirectiveSuccessTracker();
  // 模拟网关引擎写路径：效果在「当前板」上现算并原地更新（同一轮多条效果依次累加）
  const liveBoard = opts.board;
  const coc7 = new Coc7RuleBook();
  const hpEffects: Array<{
    key: string;
    kind: 'damage' | 'heal';
    roll: ParsedRoll;
    before: number;
    after: number;
  }> = [];
  const sanityEffects: Array<{
    key: string;
    sanRoll: number;
    lossRoll: ParsedRoll;
    loss: number;
    before: number;
    after: number;
  }> = [];
  const calls: { messages: LlmMessage[] }[] = [];
  const dice: ParsedRoll[] = [];
  const results: string[] = [];
  const alerts: { code: ErrorCode; message: string }[] = [];
  const deltas: string[] = [];
  const narrations: { triggerSeq: number; content: string; aborted: boolean }[] = [];
  const records: DirectiveScanEvent[] = [];
  let fallbacks = 0;

  const llm: LlmAdapter = {
    id: 'scripted',
    async chat(req, onDelta) {
      const index = calls.length;
      // 安全网：编排用尽仍被请求 = 续写条件没收敛（死循环），直接让用例失败
      if (index >= replies.length) {
        throw new Error(`未编排的第 ${index + 1} 次 LLM 请求（疑似续写未收敛）`);
      }
      const reply = replies[index]!;
      calls.push({ messages: [...req.messages] });
      if (reply.error) throw reply.error;
      for (const chunk of reply.chunks ?? []) onDelta(chunk);
      return {
        content: (reply.chunks ?? []).join(''),
        finishReason: reply.aborted ? 'aborted' : 'stop',
        aborted: reply.aborted ?? false,
      };
    },
  };

  const ports: AiTurnPorts = {
    llm,
    chat: { model: 'test-model', temperature: 0.7, maxTokens: 512 },
    roster: rosterOf(60),
    random: fixed(40),
    tracker,
    getBoard: () => liveBoard,
    applyHpEffect: async (key, kind, roll) => {
      if (!liveBoard) return null;
      const produced = hpPatch(liveBoard, key, kind, roll);
      if (!produced.ok) return null;
      const pc = liveBoard.pcs[key];
      if (!pc || pc.sheet.rulebook !== 'dnd5e') return null;
      const lock = applyStatePatch(liveBoard, produced.patch, liveBoard.version);
      if (!lock.ok) return null;
      const before = pc.sheet.hp.current;
      Object.assign(liveBoard, lock.next);
      const after = liveBoard.pcs[key]?.sheet;
      if (!after || after.rulebook !== 'dnd5e') return null;
      hpEffects.push({ key, kind, roll, before, after: after.hp.current });
      return { before, after: after.hp.current };
    },
    applySanityEffect: async (key, sanRoll, lossHint, random) => {
      if (!liveBoard) return null;
      const pc = liveBoard.pcs[key];
      if (!pc || pc.sheet.rulebook !== 'coc7') return null;
      const tier = coc7.sanityRule(sanRoll, pc.sheet.san);
      const lossExpr = lossHint ?? tier.loss;
      const lossRoll = rollDice(lossExpr, { random: random ?? fixed(1), rulebook: coc7 });
      const produced = sanityLossPatch(liveBoard, key, sanRoll, lossRoll, coc7);
      if (!produced.ok) return null;
      const lock = applyStatePatch(liveBoard, produced.patch, liveBoard.version);
      if (!lock.ok) return null;
      const before = pc.sheet.san;
      Object.assign(liveBoard, lock.next);
      const after = liveBoard.pcs[key]?.sheet;
      if (!after || after.rulebook !== 'coc7') return null;
      sanityEffects.push({ key, sanRoll, lossRoll, loss: produced.loss, before, after: after.san });
      return {
        lossRoll,
        loss: produced.loss,
        before,
        after: after.san,
        desc: lossHint ? `KP 指定损失 ${lossExpr}` : tier.desc,
      };
    },
    buildMessages: async () => [{ role: 'user', content: '玩家：我翻查书桌。' }],
    emitDice: async (roll) => {
      dice.push(roll);
    },
    emitDirectiveResult: async (content) => {
      results.push(content);
    },
    emitNarrationDelta: (_seq, delta) => {
      deltas.push(delta);
    },
    finishNarration: async (triggerSeq, content, aborted) => {
      narrations.push({ triggerSeq, content, aborted });
    },
    alertKp: (code, message) => {
      alerts.push({ code, message });
    },
    recordDirective: (ev) => {
      records.push(ev);
    },
    notifyFallback: async () => {
      fallbacks += 1;
    },
    ...over,
  };

  return {
    ports,
    calls,
    dice,
    results,
    alerts,
    deltas,
    narrations,
    get fallbacks() {
      return fallbacks;
    },
    tracker,
    records,
    hpEffects,
    sanityEffects,
  };
}

describe('纯叙事（无指令块）', () => {
  it('一次请求即收尾：增量原样广播，叙事完整落盘，不掷骰不告警', async () => {
    const h = harness([{ chunks: ['你走进书房。', '灰尘在光柱里浮动。'] }]);
    await runAiTurn(7, h.ports);

    expect(h.calls).toHaveLength(1); // 无检定 → 不续写
    expect(h.deltas).toEqual(['你走进书房。', '灰尘在光柱里浮动。']);
    expect(h.narrations).toEqual([
      { triggerSeq: 7, content: '你走进书房。灰尘在光柱里浮动。', aborted: false },
    ]);
    expect(h.dice).toHaveLength(0);
    expect(h.alerts).toHaveLength(0);
    expect(h.fallbacks).toBe(0);
  });
});

describe('检定闭环（TC-FR-05-001 编排侧）', () => {
  it('指令块 → 服务端掷骰 → 回注 → 续写一段', async () => {
    const h = harness([
      { chunks: ['你翻查书桌。\n', fence(checkJson()), '抽屉卡住了。'] },
      { chunks: ['你使劲一拉，抽屉开了。'] },
    ]);
    await runAiTurn(1, h.ports);

    expect(h.calls).toHaveLength(2); // 执行了检定 → 续写一次
    expect(h.dice).toHaveLength(1);
    expect(h.dice[0]!.expr).toBe('1d100<=60');
    expect(h.dice[0]!.rolls).toEqual([[40]]);
    expect(h.results).toEqual(['【检定】爱丽丝 侦查（翻查书桌）：1d100<=60 → 40，成功']);
    expect(h.tracker.attempts).toBe(1);
    expect(h.tracker.successRate).toBe(1);
    expect(h.narrations).toHaveLength(2);
    expect(h.narrations[0]!.content).toContain('抽屉卡住了');
    expect(h.narrations[1]!.content).toBe('你使劲一拉，抽屉开了。');
  });

  it('续写时回注已进入上下文：第二次请求重新组装 prompt', async () => {
    let builds = 0;
    const h = harness([{ chunks: [fence(checkJson())] }, { chunks: ['后续叙事。'] }], {
      buildMessages: async () => {
        builds += 1;
        return [{ role: 'user', content: `第 ${builds} 次组装` }];
      },
    });
    await runAiTurn(1, h.ports);

    expect(builds).toBe(2);
    expect(h.calls[1]!.messages[0]!.content).toBe('第 2 次组装');
  });

  it('跨 delta 切开的指令块同样能识别（流式安全）', async () => {
    const h = harness([
      { chunks: ['你翻查。\n', '```aid', 'le\n', checkJson(), '\n``', '`\n', '一无所获。'] },
      { chunks: ['你转向书架。'] },
    ]);
    await runAiTurn(1, h.ports);

    expect(h.dice).toHaveLength(1);
    // 指令块是内部协议：识别照常，但不得流入广播增量（TDD §5.4）
    expect(h.deltas.join('')).not.toContain(checkJson());
    expect(h.deltas.join('')).not.toContain('```aidle');
  });
});

describe('检定循环上限（TC-FR-05-006/007）', () => {
  it('同一请求内第 4 块被拦：前 3 次执行，剩余请求强制收尾', async () => {
    const h = harness([
      {
        chunks: [
          fence(checkJson()),
          fence(checkJson({ skill: '聆听' })),
          fence(checkJson({ skill: '图书馆' })),
          fence(checkJson({ skill: '撬锁' })),
        ],
      },
      { chunks: ['你收起工具，离开书房。'] },
    ]);
    await runAiTurn(1, h.ports);

    expect(MAX_CHECKS_PER_TURN).toBe(3);
    expect(h.dice).toHaveLength(3);
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]).toMatchObject({ code: 'E-AI-01' });
    expect(h.alerts[0]!.message).toContain('上限');
    // 收尾元指令注入在下一请求，请求数仍有界
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.messages.some((m) => m.content === NO_MORE_CHECKS_META)).toBe(true);
    expect(h.narrations).toHaveLength(2);
  });

  it('上限跨请求累计：三次续写后第四次请求仍出指令 → 拦下并收尾', async () => {
    const h = harness([
      { chunks: [fence(checkJson({ skill: '侦查' }))] },
      { chunks: [fence(checkJson({ skill: '聆听' }))] },
      { chunks: [fence(checkJson({ skill: '图书馆' }))] },
      { chunks: [fence(checkJson({ skill: '撬锁' }))] },
      { chunks: ['你收手。'] },
    ]);
    await runAiTurn(1, h.ports);

    expect(h.dice).toHaveLength(3);
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]!.message).toContain('上限');
    expect(h.calls).toHaveLength(5);
    expect(h.calls[4]!.messages.some((m) => m.content === NO_MORE_CHECKS_META)).toBe(true);
  });

  it('收尾请求仍出指令：只告警不再续写（请求数有界）', async () => {
    const h = harness([
      { chunks: [fence(checkJson()), fence(checkJson()), fence(checkJson()), fence(checkJson())] },
      { chunks: [fence(checkJson()), '你罢手。'] },
    ]);
    await runAiTurn(1, h.ports);

    expect(h.dice).toHaveLength(3);
    expect(h.alerts).toHaveLength(2); // 第一请求拦 1 次 + 收尾请求再拦 1 次
    expect(h.calls).toHaveLength(2); // 收尾请求 executedHere=0 → 结束
  });
});

describe('指令块剥离（TDD §5.4：内部协议不出现在玩家可见输出）', () => {
  it('叙事落盘不含指令块：块前/块后文本保留，广播增量同样无块内容', async () => {
    const h = harness([
      { chunks: ['你翻查书桌。\n', fence(checkJson()), '抽屉卡住了。'] },
      { chunks: ['你使劲一拉。'] },
    ]);
    await runAiTurn(1, h.ports);

    expect(h.narrations[0]!.content).toContain('你翻查书桌。');
    expect(h.narrations[0]!.content).toContain('抽屉卡住了。');
    expect(h.narrations[0]!.content).not.toContain('aidle');
    expect(h.narrations[0]!.content).not.toContain(checkJson());
    expect(h.deltas.join('')).not.toContain(checkJson());
  });

  it('解析失败 / 白名单拒绝的原始块同样不进叙事', async () => {
    const h = harness([{ chunks: ['前文。\n', fence('{"op": "check" 坏'), '后文。'] }]);
    await runAiTurn(1, h.ports);

    expect(h.alerts).toHaveLength(1); // E-AI-01 照常告警
    expect(h.narrations[0]!.content).toContain('前文。');
    expect(h.narrations[0]!.content).toContain('后文。');
    expect(h.narrations[0]!.content).not.toContain('op');
  });

  it('截断块（流终未闭合）不进叙事，块前文本保留', async () => {
    // 块前文本独立成行；```aidle 行后直到流终都未闭合 → 截断丢弃
    const h = harness([{ chunks: ['你翻找。\n', '```aidle\n{"op": "check"'] }]);
    await runAiTurn(1, h.ports);

    expect(h.narrations[0]!.content).toBe('你翻找。\n');
  });

  it('行中伪栅栏不是指令块：整体按普通文本广播与落盘', async () => {
    // '你翻找。```aidle' 行首不是 ```，不构成开栅栏——剥离不得误伤普通文本
    const h = harness([{ chunks: ['你翻找。', '```aidle\n{"op": "check"'] }]);
    await runAiTurn(1, h.ports);

    expect(h.narrations[0]!.content).toBe('你翻找。```aidle\n{"op": "check"');
  });
});

describe('失败事件 → E-AI-01 只达 KP（玩家无感）', () => {
  it('解析失败：计入 R-01，不掷骰、不续写、不提示玩家', async () => {
    const h = harness([{ chunks: ['你翻找。\n', fence('{"op": "check" 未闭合'), '什么也没有。'] }]);
    await runAiTurn(1, h.ports);

    expect(h.dice).toHaveLength(0);
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]).toMatchObject({ code: 'E-AI-01' });
    expect(h.calls).toHaveLength(1);
    expect(h.fallbacks).toBe(0);
    expect(h.tracker.successRate).toBe(0);
  });

  it('白名单拒绝（未知 op）：原因可读，不掷骰', async () => {
    const h = harness([
      { chunks: [fence('{"op": "roll", "target": "pc:alice", "skill": "侦查"}')] },
    ]);
    await runAiTurn(1, h.ports);

    expect(h.dice).toHaveLength(0);
    expect(h.alerts[0]!.message).toContain('未知 op');
    expect(h.tracker.attempts).toBe(1);
  });

  it('执行失败（名册查无 PC）：不掷骰、不续写', async () => {
    const h = harness([{ chunks: [fence(checkJson()), '你放弃。'] }], {
      roster: { skillValue: () => ({ found: false, reason: 'pc-not-found' }) },
    });
    await runAiTurn(1, h.ports);

    expect(h.dice).toHaveLength(0);
    expect(h.results).toHaveLength(0);
    expect(h.alerts[0]!.message).toContain('查无 PC');
    expect(h.calls).toHaveLength(1);
    expect(h.tracker.successRate).toBe(0);
  });

  it('截断块（未闭合栅栏）：既不计入 R-01 也不告警', async () => {
    const h = harness([{ chunks: ['你翻找。', '```aidle\n{"op": "check"'] }]);
    await runAiTurn(1, h.ports);

    expect(h.dice).toHaveLength(0);
    expect(h.alerts).toHaveLength(0);
    expect(h.tracker.attempts).toBe(0); // 分母不含截断块
  });
});

describe('失败块留档（T-M3-07，测试文档 §12.4）', () => {
  it('解析失败：原始文本与原因一并交给留档端口', async () => {
    const h = harness([{ chunks: ['你翻找。\n', fence('{"op": "check" 未闭合'), '什么也没有。'] }]);
    await runAiTurn(1, h.ports);

    expect(h.records).toHaveLength(1);
    expect(h.records[0]).toMatchObject({
      kind: 'parse-error',
      raw: expect.stringContaining('未闭合'),
      reason: expect.any(String),
    });
  });

  it('白名单拒绝：同样留档（未知 op 是常见失败形态）', async () => {
    const h = harness([
      { chunks: [fence('{"op": "roll", "target": "pc:alice", "skill": "侦查"}')] },
    ]);
    await runAiTurn(1, h.ports);

    expect(h.records).toHaveLength(1);
    expect(h.records[0]).toMatchObject({ kind: 'rejected', raw: expect.any(String) });
  });

  it('截断块与循环上限拦截都不留档：二者不计入 R-01 分母', async () => {
    const truncated = harness([{ chunks: ['```aidle\n{"op": "check"'] }]);
    await runAiTurn(1, truncated.ports);
    expect(truncated.records).toHaveLength(0);

    const limit = harness([
      {
        chunks: [fence(checkJson()), fence(checkJson()), fence(checkJson()), fence(checkJson())],
      },
      { chunks: ['收尾。'] },
    ]);
    await runAiTurn(1, limit.ports);

    // 4 块：3 块执行成功，第 4 块被上限拦截——成功与拦截都不属于「解析失败」
    expect(limit.dice).toHaveLength(3);
    expect(limit.records).toHaveLength(0);
  });
});

describe('降级链（T-M3-05，R-01）', () => {
  it('一级降级：成功率跌破 95% → 下一请求追加少样本示例', async () => {
    const tracker = new DirectiveSuccessTracker();
    tracker.record(false); // 预置窗口：0/1 → 需要少样本
    const h = harness([{ chunks: [fence(checkJson()), '抽屉开了。'] }, { chunks: ['你继续。'] }], {
      tracker,
    });
    await runAiTurn(1, h.ports);

    expect(h.calls[0]!.messages.some((m) => m.content === FEW_SHOT_EXAMPLES)).toBe(true);
    // 原始 prompt 保留，示例只是追加
    expect(h.calls[0]!.messages.some((m) => m.content === '玩家：我翻查书桌。')).toBe(true);
    expect(h.fallbacks).toBe(0); // 少样本期间成功 → 不触发二级
  });

  it('二级降级：少样本生效期间仍失败 → 停用协议 + 提示玩家 .r，后续指令块被忽略', async () => {
    const tracker = new DirectiveSuccessTracker();
    tracker.record(false); // 使 needsFewShot=true
    const h = harness([{ chunks: [fence('{"op": "check" 坏'), fence(checkJson())] }], { tracker });
    await runAiTurn(1, h.ports);

    expect(h.fallbacks).toBe(1);
    expect(h.dice).toHaveLength(0); // 坏块之后的合法块也被忽略（协议已停用）
    expect(h.tracker.attempts).toBe(2); // 预置 1 + 坏块 1；被忽略的块不计数
    expect(h.alerts.length).toBeGreaterThanOrEqual(1);
    expect(h.calls).toHaveLength(1);
  });
});

describe('异常与中断（E-LLM-01 / E-LLM-02）', () => {
  it('LLM 抛错 → 告警后终止回合，叙事标记中断', async () => {
    const h = harness([{ error: new LlmError('E-LLM-01', '上游超时', { retryable: false }) }]);
    await runAiTurn(3, h.ports);

    expect(h.alerts).toEqual([{ code: 'E-LLM-01', message: '上游超时' }]);
    expect(h.narrations).toEqual([{ triggerSeq: 3, content: '\n（生成中断）', aborted: true }]);
    expect(h.calls).toHaveLength(1); // 不再续写
    expect(h.dice).toHaveLength(0);
  });

  it('流中断：已收增量保留并标记「生成中断」', async () => {
    const h = harness([{ chunks: ['你推开', '门。'], aborted: true }]);
    await runAiTurn(2, h.ports);

    expect(h.narrations).toEqual([
      { triggerSeq: 2, content: '你推开门。\n（生成中断）', aborted: true },
    ]);
    expect(h.alerts).toHaveLength(0); // 中断不是指令协议错误
  });

  it('中断前已执行的检定照常落账', async () => {
    const h = harness([{ chunks: [fence(checkJson()), '门后传来'], aborted: true }]);
    await runAiTurn(2, h.ports);

    expect(h.dice).toHaveLength(1);
    expect(h.results).toHaveLength(1);
    expect(h.narrations[0]!.aborted).toBe(true);
  });
});

describe('回注文案 directiveResultText', () => {
  const directive = (over: Partial<CheckDirective> = {}): CheckDirective => ({
    op: 'check',
    target: 'pc:alice',
    skill: '侦查',
    difficulty: 'normal',
    label: '翻查书桌',
    ...over,
  });

  const roll = (total: number, check: RollCheck | null): ParsedRoll => ({
    expr: '1d100<=60',
    raw: '1d100<=60',
    rolls: [[total]],
    kept: [total],
    total,
    check,
  });

  const checkOf = (outcome: CheckOutcome, grade?: CheckGrade): RollCheck => ({
    rulebook: 'coc7',
    kind: 'skill',
    target: 60,
    difficulty: 'normal',
    outcome,
    grade,
  });

  it.each([
    ['成功', 40, checkOf('success', 'normal'), '成功'],
    ['困难成功', 25, checkOf('success', 'hard'), '困难成功'],
    ['极难成功', 10, checkOf('success', 'extreme'), '极难成功'],
    ['大成功', 1, checkOf('critical'), '大成功'],
    ['失败', 90, checkOf('fail'), '失败'],
    ['大失败', 100, checkOf('fumble'), '大失败'],
  ])('%s：等级文案人类可读', (_name, total, check, verdict) => {
    expect(directiveResultText(directive(), roll(total, check), '爱丽丝')).toBe(
      `【检定】爱丽丝 侦查（翻查书桌）：1d100<=60 → ${total}，${verdict}`,
    );
  });

  it('无判定记录（纯骰）时只报数值，不臆造结论', () => {
    expect(directiveResultText(directive(), roll(40, null), '爱丽丝')).toBe(
      '【检定】爱丽丝 侦查（翻查书桌）：1d100<=60 → 40',
    );
  });

  it('label 省略时不留空括号', () => {
    const d = directive();
    delete (d as { label?: string }).label;
    expect(directiveResultText(d, roll(40, checkOf('success', 'normal')), '爱丽丝')).toBe(
      '【检定】爱丽丝 侦查：1d100<=60 → 40，成功',
    );
  });
});

// ---- 数值效果闭环（T-M8-03/04，FR-25/27，设计 §5.4）----

/** 顺序随机源：按入参依次出值（多颗骰按掷骰顺序消费） */
const seqRandom = (...ints: number[]): RandomSource => {
  const queue = [...ints];
  return { int: () => queue.shift() ?? 1 };
};

const board5e = (current = 22, max = 22): StateBoard => ({
  version: 4,
  pcs: {
    alice: {
      sheet: {
        rulebook: 'dnd5e',
        playerName: '爱丽丝',
        occupation: '战士',
        abilities: { str: 16, dex: 14, con: 14, int: 10, wis: 12, cha: 8 },
        proficiencyBonus: 2,
        ac: 16,
        hp: { max, current },
        proficientSkills: [],
        proficientSaves: ['str', 'con'],
      },
      conditions: [],
    },
  },
  scene: { name: '', time: '', publicDesc: '' },
  facts: [],
  updatedAt: '1970-01-01T00:00:00.000Z',
});

const boardCoc7 = (san = 55): StateBoard => ({
  version: 4,
  pcs: {
    alice: {
      sheet: {
        rulebook: 'coc7',
        playerName: '爱丽丝',
        occupation: '记者',
        str: 50,
        con: 60,
        siz: 55,
        dex: 70,
        app: 50,
        int: 75,
        pow: 55,
        edu: 80,
        luck: 40,
        hp: 11,
        mp: 11,
        san,
        db: '0',
        build: '0',
        skills: { 侦查: 60 },
      },
      conditions: [],
    },
  },
  scene: { name: '', time: '', publicDesc: '' },
  facts: [],
  updatedAt: '1970-01-01T00:00:00.000Z',
});

describe('damage/heal 闭环（T-M8-03，FR-25）', () => {
  it('damage：服务端掷 expr → DiceMsg → 引擎 patch 落盘端口 → 回注含 HP 前后值', async () => {
    const h = harness(
      [
        {
          chunks: [
            '哥布林挥刀砍来。\n',
            fence(
              JSON.stringify({ op: 'damage', target: 'pc:alice', expr: '1d8+2', label: '弯刀' }),
            ),
            '鲜血溅出。',
          ],
        },
        { chunks: ['你踉跄后退。'] },
      ],
      { random: seqRandom(5) },
      { board: board5e() },
    );
    await runAiTurn(1, h.ports);

    expect(h.calls).toHaveLength(2); // 效果指令同样触发续写
    expect(h.dice).toHaveLength(1);
    expect(h.dice[0]!.expr).toBe('1d8+2');
    expect(h.dice[0]!.total).toBe(7); // d8=5 + 2
    expect(h.dice[0]!.check).toBeNull(); // 效果骰无判定
    expect(h.hpEffects).toHaveLength(1);
    expect(h.hpEffects[0]).toMatchObject({ key: 'alice', kind: 'damage', before: 22, after: 15 });
    expect(h.results).toEqual(['【伤害】爱丽丝（弯刀）：1d8+2 → 7，HP 22 → 15']);
    expect(h.tracker.successRate).toBe(1);
    expect(h.alerts).toHaveLength(0);
  });

  it('heal：治疗骰回注文案与 patch 方向正确', async () => {
    const h = harness(
      [
        { chunks: [fence(JSON.stringify({ op: 'heal', target: 'pc:alice', expr: '2d4+2' }))] },
        { chunks: ['暖流涌动。'] },
      ],
      { random: seqRandom(2, 3) },
      { board: board5e(12) },
    );
    await runAiTurn(1, h.ports);

    expect(h.dice[0]!.total).toBe(7); // 2+3+2
    expect(h.hpEffects[0]).toMatchObject({ kind: 'heal', before: 12, after: 19 });
    expect(h.results[0]).toContain('HP 12 → 19');
  });

  it('COC 卡收到 damage → E-AI-01 防呆拒绝：不掷骰、不出 patch、计 R-01', async () => {
    const h = harness(
      [
        { chunks: [fence(JSON.stringify({ op: 'damage', target: 'pc:alice', expr: '1d8' }))] },
        { chunks: ['叙事继续。'] },
      ],
      {},
      { board: boardCoc7() },
    );
    await runAiTurn(1, h.ports);

    expect(h.dice).toHaveLength(0);
    expect(h.hpEffects).toHaveLength(0);
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]).toMatchObject({ code: 'E-AI-01' });
    expect(h.alerts[0]!.message).toContain('不是 5e 卡');
    expect(h.tracker.successRate).toBe(0);
  });

  it.each([
    ['无效骰式', { op: 'damage', target: 'pc:alice', expr: '不是骰式' }, '无效'],
    ['判定后缀混入效果骰', { op: 'damage', target: 'pc:alice', expr: '1d8>=5' }, '判定后缀'],
    ['查无此 PC', { op: 'heal', target: 'pc:ghost', expr: '1d4' }, '查无 PC'],
  ])('%s → E-AI-01 拒绝且不掷骰', async (_name, directiveJson, reasonPart) => {
    const h = harness(
      [{ chunks: [fence(JSON.stringify(directiveJson))] }, { chunks: ['叙事继续。'] }],
      {},
      { board: board5e() },
    );
    await runAiTurn(1, h.ports);

    expect(h.dice).toHaveLength(0);
    expect(h.hpEffects).toHaveLength(0);
    expect(h.alerts[0]).toMatchObject({ code: 'E-AI-01' });
    if (h.alerts[0]) expect(h.alerts[0].message).toContain(reasonPart);
  });
});

describe('sanity 闭环（T-M8-04，FR-27，T-M5-08 最后一步）', () => {
  it('SAN 检定失败 → 房规损失表 1d6 → 服务端掷损失骰 → 扣 SAN → 回注全链路', async () => {
    const h = harness(
      [
        {
          chunks: [
            '不可名状之物映入眼帘。\n',
            fence(JSON.stringify({ op: 'sanity', target: 'pc:alice', label: '目击旧日支配者' })),
            '你僵在原地。',
          ],
        },
        { chunks: ['你缓缓回过神。'] },
      ],
      { random: seqRandom(80, 4) },
      { board: boardCoc7() },
    );
    await runAiTurn(1, h.ports);

    expect(h.calls).toHaveLength(2);
    // 检定骰经 emitDice 落盘；损失骰由端口内部 recordDice（网关队列内），经 sanityEffects 观测
    expect(h.dice).toHaveLength(1);
    expect(h.dice[0]!.expr).toBe('1d100<=55');
    expect(h.dice[0]!.total).toBe(80);
    expect(h.dice[0]!.check).toMatchObject({ kind: 'sanity', outcome: 'fail' });
    expect(h.sanityEffects).toHaveLength(1);
    expect(h.sanityEffects[0]!.lossRoll.expr).toBe('1d6'); // 失败档损失表
    expect(h.sanityEffects[0]!.lossRoll.total).toBe(4);
    expect(h.sanityEffects[0]).toMatchObject({
      key: 'alice',
      sanRoll: 80,
      loss: 4,
      before: 55,
      after: 51,
    });
    expect(h.results).toEqual([
      '【理智检定】爱丽丝（目击旧日支配者）：1d100<=55 → 80，失败，失败：损失 1d6 = 4，SAN 55 → 51',
    ]);
  });

  it('KP 显式指定损失表达式 → 覆盖房规表（仍由服务端掷骰）', async () => {
    const h = harness(
      [
        { chunks: [fence(JSON.stringify({ op: 'sanity', target: 'pc:alice', loss: '1d10' }))] },
        { chunks: ['叙事。'] },
      ],
      { random: seqRandom(30, 2) },
      { board: boardCoc7() },
    );
    await runAiTurn(1, h.ports);

    expect(h.sanityEffects[0]!.lossRoll.expr).toBe('1d10'); // KP 指定，非失败档 1d2
    expect(h.results[0]).toContain('KP 指定损失 1d10 = 2');
    expect(h.sanityEffects[0]).toMatchObject({ loss: 2, before: 55, after: 53 });
  });

  it('损失超过当前 SAN → 扣到 0（clamp，G-M8 门禁项）', async () => {
    const h = harness(
      [
        { chunks: [fence(JSON.stringify({ op: 'sanity', target: 'pc:alice' }))] },
        { chunks: ['叙事。'] },
      ],
      { random: seqRandom(90, 6) },
      { board: boardCoc7(3) },
    );
    await runAiTurn(1, h.ports);

    expect(h.sanityEffects[0]).toMatchObject({ loss: 3, before: 3, after: 0 });
    expect(h.results[0]).toContain('SAN 3 → 0');
  });

  it('5e 卡收到 sanity → E-AI-01 防呆拒绝：不掷骰、不出 patch', async () => {
    const h = harness(
      [
        { chunks: [fence(JSON.stringify({ op: 'sanity', target: 'pc:alice' }))] },
        { chunks: ['叙事。'] },
      ],
      {},
      { board: board5e() },
    );
    await runAiTurn(1, h.ports);

    expect(h.dice).toHaveLength(0);
    expect(h.sanityEffects).toHaveLength(0);
    expect(h.alerts[0]).toMatchObject({ code: 'E-AI-01' });
    if (h.alerts[0]) expect(h.alerts[0].message).toContain('不是 COC7 卡');
  });

  it('未开团（getBoard=undefined）→ E-AI-01 拒绝', async () => {
    const h = harness([
      { chunks: [fence(JSON.stringify({ op: 'damage', target: 'pc:alice', expr: '1d8' }))] },
      { chunks: ['叙事。'] },
    ]);
    await runAiTurn(1, h.ports);

    expect(h.dice).toHaveLength(0);
    expect(h.alerts[0]).toMatchObject({ code: 'E-AI-01' });
    if (h.alerts[0]) expect(h.alerts[0].message).toContain('查无 PC');
  });
});

describe('数值效果回注文案（T-M8-03/04）', () => {
  const roll = {
    expr: '1d8+2',
    raw: '1d8+2',
    rolls: [[5]],
    kept: [5],
    total: 7,
    check: null,
  } as unknown as ParsedRoll;

  it('damage/heal 文案：骰式 → 面值 → HP 前后值（前后值以队列内应用结果为准）', () => {
    expect(
      hpResultText(
        { op: 'damage', target: 'pc:alice', expr: '1d8+2', label: '弯刀' },
        '爱丽丝',
        roll,
        { before: 22, after: 15 },
      ),
    ).toBe('【伤害】爱丽丝（弯刀）：1d8+2 → 7，HP 22 → 15');
    expect(
      hpResultText({ op: 'heal', target: 'pc:alice', expr: '1d8+2' }, '爱丽丝', roll, {
        before: 22,
        after: 22,
      }),
    ).toBe('【治疗】爱丽丝：1d8+2 → 7，HP 22 → 22');
  });

  it('sanity 文案：检定结果 + 损失表档位 + SAN 前后值', () => {
    const checkRoll = {
      expr: '1d100<=55',
      raw: '1d100<=55',
      rolls: [[80]],
      kept: [80],
      total: 80,
      check: {
        rulebook: 'coc7',
        kind: 'sanity',
        target: 55,
        difficulty: 'normal',
        outcome: 'fail',
      },
    } as unknown as ParsedRoll;
    const applied = {
      lossRoll: { ...roll, expr: '1d6', total: 4 },
      loss: 4,
      before: 55,
      after: 51,
      desc: '失败：损失 1d6',
    };
    expect(
      sanityResultText(
        { op: 'sanity', target: 'pc:alice', label: '目击旧日支配者' },
        '爱丽丝',
        checkRoll,
        applied,
      ),
    ).toBe(
      '【理智检定】爱丽丝（目击旧日支配者）：1d100<=55 → 80，失败，失败：损失 1d6 = 4，SAN 55 → 51',
    );
  });
});
