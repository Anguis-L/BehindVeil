import { describe, expect, it } from 'vitest';
import { diffLines, loadGoldenCases, runGoldenCaseSync } from './runner.js';

/**
 * TC-NFR-09-001：黄金用例框架验收（M0 只要求框架可用 + ≥3 条演示用例）。
 * M2 的 T-M2-07 会按测试文档 §6.3 的编制清单把用例集扩充到 ≥30 条（TC-NFR-09-002）。
 */

const cases = await loadGoldenCases();

describe('黄金用例集', () => {
  it('至少 3 条演示用例（M2 目标 ≥30）', () => {
    expect(cases.length).toBeGreaterThanOrEqual(3);
  });

  it.each(cases)('用例 $name 通过', (goldenCase) => {
    const result = runGoldenCaseSync(goldenCase);

    expect(result.diffs, `${result.name} 差异：\n${result.diffs.join('\n')}`).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe('diff 机制（行为变更必须显式改用例）', () => {
  it('一致时无差异输出', () => {
    expect(diffLines({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] })).toEqual([]);
  });

  it('不一致时输出可读差异（行号 + 期望/实际）', () => {
    const diffs = diffLines({ role: 'system' }, { role: 'user' });

    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toContain('期望');
    expect(diffs[0]).toContain('实际');
  });

  it('缺失字段也能被检出', () => {
    expect(diffLines({ a: 1, b: 2 }, { a: 1 }).length).toBeGreaterThan(0);
  });
});
