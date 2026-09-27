import type { CheckGrade, CheckOutcome, ErrorCode, RollCheck } from '@behindveil/shared';
import { describe, expect, it } from 'vitest';
import type { ParsedRoll } from '../dice/evaluator.js';
import type { RandomSource } from '../dice/random.js';
import { LlmError, type LlmAdapter, type LlmMessage } from '../llm.js';
import { DirectiveSuccessTracker } from './degrade.js';
import type { PcRoster } from './executor.js';
import {
  directiveResultText,
  FEW_SHOT_EXAMPLES,
  MAX_CHECKS_PER_TURN,
  NO_MORE_CHECKS_META,
  runAiTurn,
  type AiTurnPorts,
} from './loop.js';
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
}

function harness(replies: ScriptedReply[], over: Partial<AiTurnPorts> = {}): Harness {
  const tracker = over.tracker ?? new DirectiveSuccessTracker();
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
    expect(h.deltas.join('')).toContain(checkJson());
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
