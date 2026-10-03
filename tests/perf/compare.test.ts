import { describe, expect, it } from 'vitest';
import {
  compareMetrics,
  fingerprintsMatch,
  machineFingerprint,
  PERF_SPECS,
  type BaselineFile,
} from './baseline.js';

/**
 * NFR-10 对比逻辑单测（T-M10-00）：容差判定、绝对豁免、预算口径、
 * 缺失指标红灯、机器指纹比对。基线值不参与测量，全部合成数据。
 */

function makeBaseline(metrics: Record<string, number>): BaselineFile {
  return {
    specVersion: 1,
    recordedAt: '2026-10-03T00:00:00.000Z',
    machine: machineFingerprint(),
    metrics,
  };
}

/** 单指标对比：基线值显式给定，当前值来自 current（compareMetrics 恒按全规格表返回） */
function resultFor(baselineValue: number, current: Record<string, number>, key: string) {
  const results = compareMetrics(makeBaseline({ [key]: baselineValue }), current);
  const found = results.find((r) => r.key === key);
  if (!found) throw new Error(`规格表缺少 ${key}`);
  return found;
}

describe('compareMetrics', () => {
  it('六指标全部在容差内 → 全绿', () => {
    const baseline = makeBaseline({
      scan_batch_ms: 10,
      pipeline_batch_ms: 20,
      first_token_p50_ms: 10,
      soak_msgs_total: 20,
      soak_rss_growth_mb: 30,
      backup_fsync_p99_delta_ms: 2,
    });
    const results = compareMetrics(baseline, {
      scan_batch_ms: 11.9, // +19% < +20%
      pipeline_batch_ms: 24, // +20% 恰在容差边界（≤）
      first_token_p50_ms: 10,
      soak_msgs_total: 20,
      soak_rss_growth_mb: 99,
      backup_fsync_p99_delta_ms: 2,
    });
    expect(results.map((r) => r.ok)).toEqual([true, true, true, true, true, true]);
  });

  it('扫描 max() 预算形：基线+20% 超限但仍在绝对预算内 → 放行；超过绝对预算 → 红灯', () => {
    // 基线 10ms，+34% = 13.4ms：超相对容差，但阈值 = max(绝对 50ms, 12ms) = 50ms → 放行
    const withinAbsolute = resultFor(10, { scan_batch_ms: 13.4 }, 'scan_batch_ms');
    expect(withinAbsolute.ok).toBe(true);
    expect(withinAbsolute.detail).toContain('max(绝对 50');
    // 55ms > max(50, 12) → 红灯
    const beyondAbsolute = resultFor(10, { scan_batch_ms: 55 }, 'scan_batch_ms');
    expect(beyondAbsolute.ok).toBe(false);
    expect(beyondAbsolute.detail).toContain('超限');
  });

  it('first_token 绝对豁免：劣化 ≤ floorMs(2ms) 放行，超过则红灯', () => {
    const withinFloor = resultFor(5, { first_token_p50_ms: 6.5 }, 'first_token_p50_ms'); // +30% 但仅 +1.5ms
    expect(withinFloor.ok).toBe(true);
    const beyondFloor = resultFor(5, { first_token_p50_ms: 8 }, 'first_token_p50_ms'); // +3ms > 2ms
    expect(beyondFloor.ok).toBe(false);
  });

  it('soak 消息总量方向相反：下降超 20% 红灯，上升是好事', () => {
    const dropped = resultFor(20, { soak_msgs_total: 15 }, 'soak_msgs_total'); // −25%
    expect(dropped.ok).toBe(false);
    const grew = resultFor(20, { soak_msgs_total: 40 }, 'soak_msgs_total');
    expect(grew.ok).toBe(true);
  });

  it('RSS 预算口径：超 100MB 红灯（与基线值无关）', () => {
    const overBudget = resultFor(5, { soak_rss_growth_mb: 120 }, 'soak_rss_growth_mb');
    expect(overBudget.ok).toBe(false);
    const underBudget = resultFor(5, { soak_rss_growth_mb: 99.9 }, 'soak_rss_growth_mb');
    expect(underBudget.ok).toBe(true);
  });

  it('指标缺失（基线或本轮）→ 红灯', () => {
    const baseline = makeBaseline({ scan_p95_ms: 10 });
    const [missingCurrent] = compareMetrics(baseline, {});
    expect(missingCurrent?.ok).toBe(false);
    const [missingBaseline] = compareMetrics(makeBaseline({}), { scan_p95_ms: 10 });
    expect(missingBaseline?.ok).toBe(false);
  });

  it('指标规格表完备：六指标每个 key 都有定义', () => {
    expect(PERF_SPECS.map((s) => s.key).sort()).toEqual(
      [
        'backup_fsync_p99_delta_ms',
        'first_token_p50_ms',
        'pipeline_batch_ms',
        'scan_batch_ms',
        'soak_msgs_total',
        'soak_rss_growth_mb',
      ].sort(),
    );
  });
});

describe('机器指纹', () => {
  it('同机指纹一致；任一字段不同即不匹配', () => {
    const a = machineFingerprint();
    expect(fingerprintsMatch(a, a)).toBe(true);
    expect(fingerprintsMatch(a, { ...a, platform: 'linux' })).toBe(false);
    expect(fingerprintsMatch(a, { ...a, cpuCount: a.cpuCount + 1 })).toBe(false);
    expect(fingerprintsMatch(a, { ...a, nodeMajor: a.nodeMajor + 1 })).toBe(false);
  });
});
