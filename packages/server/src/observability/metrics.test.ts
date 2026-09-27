import { describe, expect, it } from 'vitest';
import {
  COST_CNY_PER_1K_INPUT,
  COST_CNY_PER_1K_OUTPUT,
  LATENCY_SAMPLE_LIMIT,
  MetricsCollector,
  directiveRate,
  estimateCostCny,
  quantile,
} from './metrics.js';

/**
 * T-M6-03：进程内指标收集器单测（FR-13 / R-01 / R-02，TDD §9/§12）。
 * 数值类代码（分位数、滑动样本窗、成本折算）逐条钉死——这类逻辑算错是静默的，
 * 面板上只会"看起来有点不对"。
 */

/** 造一个可控时钟：uptimeSec 需要确定的"现在"才能断言 */
function fakeClock(start = 1_700_000_000_000): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

describe('quantile（最近秩法）', () => {
  it('空样本 → 0（不抛错，面板初值就是 0）', () => {
    expect(quantile([], 0.5)).toBe(0);
    expect(quantile([], 0.95)).toBe(0);
  });

  it('单样本：任意分位都是它自己', () => {
    expect(quantile([7], 0.5)).toBe(7);
    expect(quantile([7], 0.95)).toBe(7);
  });

  it('p50 / p95 取真实观测值，不做插值', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    // ceil(0.5 × 10) = 5 → 第 5 个 = 5；ceil(0.95 × 10) = 10 → 第 10 个 = 10
    expect(quantile(sorted, 0.5)).toBe(5);
    expect(quantile(sorted, 0.95)).toBe(10);
  });

  it('p95 向上取（宁高勿低）：20 个样本取第 19 个', () => {
    const sorted = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(quantile(sorted, 0.95)).toBe(19);
  });

  it('奇数个样本：ceil(0.5 × 3) = 2 → 第 2 个', () => {
    expect(quantile([1, 5, 9], 0.5)).toBe(5);
  });
});

describe('directiveRate（R-01 口径）', () => {
  it('无尝试 → 1（尚无失败证据，与 tracker.totals 一致）', () => {
    expect(directiveRate(0, 0)).toBe(1);
  });

  it('有尝试 → 成功 / 尝试', () => {
    expect(directiveRate(4, 3)).toBe(0.75);
    expect(directiveRate(2, 0)).toBe(0);
  });
});

describe('estimateCostCny（§12 成本模型）', () => {
  it('输入输出分开计价', () => {
    // 1000 in × 0.002 + 1000 out × 0.008 = 0.01
    expect(estimateCostCny(1000, 1000)).toBeCloseTo(COST_CNY_PER_1K_INPUT + COST_CNY_PER_1K_OUTPUT);
  });

  it('§12 基准：300 轮 1.8M in + 0.3M out 落在 ¥5–15 区间', () => {
    const cny = estimateCostCny(1_800_000, 300_000);
    expect(cny).toBeGreaterThanOrEqual(5);
    expect(cny).toBeLessThanOrEqual(15);
  });

  it('零 token → 0；小数位收敛到 4 位（浮点噪声不进面板）', () => {
    expect(estimateCostCny(0, 0)).toBe(0);
    // 333/1000 × 0.002 = 0.000666 → 0.0007
    expect(estimateCostCny(333, 0)).toBe(0.0007);
  });
});

describe('MetricsCollector：uptimeSec', () => {
  it('启动即 0，随时钟推进增长（向下取整）', () => {
    const clock = fakeClock();
    const metrics = new MetricsCollector(clock.now);
    expect(metrics.uptimeSec).toBe(0);
    clock.advance(1_500);
    expect(metrics.uptimeSec).toBe(1);
    clock.advance(60_000);
    expect(metrics.uptimeSec).toBe(61);
  });
});

describe('MetricsCollector：骰子累计', () => {
  it('total 全计，hidden 单独计数', () => {
    const metrics = new MetricsCollector();
    metrics.recordDice('s_1', false);
    metrics.recordDice('s_1', true);
    metrics.recordDice('s_1', true);

    const snapshot = metrics.snapshot({ attempts: 0, successes: 0 });
    expect(snapshot.dice).toEqual({ total: 3, hidden: 2 });
  });

  it('按会话分桶：会话之间互不串味，全局是各会话之和', () => {
    const metrics = new MetricsCollector();
    metrics.recordDice('s_1', true);
    metrics.recordDice('s_2', false);
    metrics.recordDice('s_2', false);

    expect(metrics.sessionSnapshot('s_1', { attempts: 0, successes: 0 }).dice).toEqual({
      total: 1,
      hidden: 1,
    });
    expect(metrics.sessionSnapshot('s_2', { attempts: 0, successes: 0 }).dice).toEqual({
      total: 2,
      hidden: 0,
    });
    expect(metrics.snapshot({ attempts: 0, successes: 0 }).dice).toEqual({ total: 3, hidden: 1 });
  });

  it('未产生过数据的会话 → 全零，不抛错', () => {
    const metrics = new MetricsCollector();
    const snapshot = metrics.sessionSnapshot('s_unknown', { attempts: 0, successes: 0 });
    expect(snapshot.sessionId).toBe('s_unknown');
    expect(snapshot.dice).toEqual({ total: 0, hidden: 0 });
    expect(snapshot.llm.latencyMs).toEqual({ p50: 0, p95: 0, max: 0, avg: 0 });
    expect(snapshot.cost.estimatedCny).toBe(0);
  });
});

describe('MetricsCollector：LLM 调用', () => {
  it('耗时 / token / 失败分别累计；失败只记耗时不记 token', () => {
    const metrics = new MetricsCollector();
    metrics.recordLlmCall('s_1', 100, { promptTokens: 6000, completionTokens: 1000 });
    metrics.recordLlmCall('s_1', 300, { promptTokens: 4000, completionTokens: 500 });
    metrics.recordLlmFailure('s_1', 900);

    const llm = metrics.sessionSnapshot('s_1', { attempts: 0, successes: 0 }).llm;
    expect(llm.calls).toBe(2);
    expect(llm.failures).toBe(1);
    expect(llm.tokensIn).toBe(10_000);
    expect(llm.tokensOut).toBe(1_500);
    // 样本 [100, 300, 900]：p50 = 第 2 个 = 300；p95 = 第 3 个 = 900
    expect(llm.latencyMs).toEqual({ p50: 300, p95: 900, max: 900, avg: (100 + 300 + 900) / 3 });
  });

  it('usage 缺省（provider 未回）时只记耗时，token 不加', () => {
    const metrics = new MetricsCollector();
    metrics.recordLlmCall('s_1', 120);
    const llm = metrics.sessionSnapshot('s_1', { attempts: 0, successes: 0 }).llm;
    expect(llm.calls).toBe(1);
    expect(llm.tokensIn).toBe(0);
    expect(llm.tokensOut).toBe(0);
    expect(llm.latencyMs.p50).toBe(120);
  });

  it('延迟样本有上限：超出后丢弃最旧的，分位数只反映最近 N 次', () => {
    const metrics = new MetricsCollector();
    // 前 LATENCY_SAMPLE_LIMIT 次都是 1000ms（慢），之后全是 10ms（快）
    for (let i = 0; i < LATENCY_SAMPLE_LIMIT; i += 1) {
      metrics.recordLlmCall('s_1', 1000, { promptTokens: 0, completionTokens: 0 });
    }
    const before = metrics.sessionSnapshot('s_1', { attempts: 0, successes: 0 }).llm.latencyMs;
    expect(before.p95).toBe(1000);

    for (let i = 0; i < LATENCY_SAMPLE_LIMIT; i += 1) {
      metrics.recordLlmCall('s_1', 10, { promptTokens: 0, completionTokens: 0 });
    }
    const after = metrics.sessionSnapshot('s_1', { attempts: 0, successes: 0 }).llm.latencyMs;
    // 窗口已整体换成快样本：慢样本一个不剩（内存不随轮次增长）
    expect(after.p50).toBe(10);
    expect(after.p95).toBe(10);
    expect(after.max).toBe(10);
    // 但累计口径不受窗口影响：2N 次调用全记着
    expect(metrics.sessionSnapshot('s_1', { attempts: 0, successes: 0 }).llm.calls).toBe(
      LATENCY_SAMPLE_LIMIT * 2,
    );
  });

  it('累计口径不随样本窗回退：total/hidden/calls/tokens 只增不减', () => {
    const metrics = new MetricsCollector();
    metrics.recordDice('s_1', true);
    metrics.recordLlmCall('s_1', 50, { promptTokens: 100, completionTokens: 20 });

    const first = metrics.snapshot({ attempts: 0, successes: 0 });
    for (let i = 0; i < LATENCY_SAMPLE_LIMIT + 10; i += 1) {
      metrics.recordLlmCall('s_1', 5, { promptTokens: 0, completionTokens: 0 });
    }
    const second = metrics.snapshot({ attempts: 0, successes: 0 });

    expect(second.dice.total).toBe(first.dice.total);
    expect(second.dice.hidden).toBe(first.dice.hidden);
    expect(second.llm.tokensIn).toBe(100);
    expect(second.llm.tokensOut).toBe(20);
    expect(second.llm.calls).toBe(first.llm.calls + LATENCY_SAMPLE_LIMIT + 10);
  });
});

describe('MetricsCollector：快照形状', () => {
  it('全局快照 = uptimeSec + directives + dice + llm（directives 由网关给，rate 在此算）', () => {
    const clock = fakeClock();
    const metrics = new MetricsCollector(clock.now);
    clock.advance(3_000);
    metrics.recordDice('s_1', false);
    metrics.recordLlmCall('s_1', 200, { promptTokens: 6000, completionTokens: 1000 });

    const snapshot = metrics.snapshot({ attempts: 10, successes: 9 });
    expect(Object.keys(snapshot).sort()).toEqual(['dice', 'directives', 'llm', 'uptimeSec']);
    expect(snapshot.uptimeSec).toBe(3);
    expect(snapshot.directives).toEqual({ attempts: 10, successes: 9, rate: 0.9 });
  });

  it('会话快照 = sessionId + directives + dice + llm + cost', () => {
    const metrics = new MetricsCollector();
    metrics.recordLlmCall('s_1', 200, { promptTokens: 6000, completionTokens: 1000 });

    const snapshot = metrics.sessionSnapshot('s_1', { attempts: 4, successes: 3 });
    expect(Object.keys(snapshot).sort()).toEqual([
      'cost',
      'dice',
      'directives',
      'llm',
      'sessionId',
    ]);
    expect(snapshot.directives).toEqual({ attempts: 4, successes: 3, rate: 0.75 });
    // 6000 in × 0.002 + 1000 out × 0.008 = 0.012 + 0.008 = 0.02
    expect(snapshot.cost.estimatedCny).toBeCloseTo(0.02, 6);
    expect(snapshot.sessionId).toBe('s_1');
  });

  it('无指令尝试时 rate = 1（面板初始不该显示 0% 吓人）', () => {
    const metrics = new MetricsCollector();
    expect(metrics.snapshot({ attempts: 0, successes: 0 }).directives.rate).toBe(1);
    expect(metrics.sessionSnapshot('s_1', { attempts: 0, successes: 0 }).directives.rate).toBe(1);
  });
});
