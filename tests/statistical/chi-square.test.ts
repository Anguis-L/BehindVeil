import { describe, expect, it } from 'vitest';
import { createCsprngRandom } from '../../packages/server/dist/domain/dice/random.js';

/**
 * T-P-06 / TC-NFR-04-001：χ² 均匀性检验（测试文档 §12.2）。
 *
 * 每骰型 n=10⁶ 次，统计量 χ² = Σ(oᵢ−e)²/e，e = n/k，自由度 df = k−1：
 *   d100 → df=99，临界值 134.64
 *   d6   → df=5， 临界值 15.09
 *   dF   → df=2， 临界值 9.21
 * χ² < 临界值即通过（α=0.01）。随机性本身会偶发波动：失败先复跑一次确认，
 * 连续两次失败按缺陷处理（排查 RandomSource 实现）。
 *
 * 样本量可用 AIDLE_CHI2_SAMPLES 覆盖（本地快速跑；门禁口径为 10⁶）。
 */

const SAMPLES = Number(process.env.AIDLE_CHI2_SAMPLES ?? 1_000_000);

function tally(min: number, max: number, samples: number): number[] {
  const random = createCsprngRandom();
  const counts = new Array<number>(max - min + 1).fill(0);
  for (let i = 0; i < samples; i += 1) {
    const index = random.int(min, max) - min;
    counts[index] = (counts[index] ?? 0) + 1;
  }
  return counts;
}

function chiSquare(counts: number[], samples: number): number {
  const expected = samples / counts.length;
  return counts.reduce((sum, observed) => sum + (observed - expected) ** 2 / expected, 0);
}

describe(`χ² 均匀性检验（n=${SAMPLES.toLocaleString('en-US')}，α=0.01）`, () => {
  it('d100：df=99，χ² < 134.64', () => {
    const counts = tally(1, 100, SAMPLES);

    expect(counts.every((count) => count > 0)).toBe(true);
    expect(chiSquare(counts, SAMPLES)).toBeLessThan(134.64);
  }, 300_000);

  it('d6：df=5，χ² < 15.09', () => {
    const counts = tally(1, 6, SAMPLES);

    expect(counts).toHaveLength(6);
    expect(chiSquare(counts, SAMPLES)).toBeLessThan(15.09);
  }, 300_000);

  it('dF（命运骰 -1/0/+1）：df=2，χ² < 9.21', () => {
    const counts = tally(-1, 1, SAMPLES);

    expect(counts).toHaveLength(3);
    expect(chiSquare(counts, SAMPLES)).toBeLessThan(9.21);
  }, 300_000);
});
