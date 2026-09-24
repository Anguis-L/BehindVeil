import { describe, expect, it } from 'vitest';
import { rollDice } from './evaluator.js';
import { createCsprngRandom } from './random.js';
import type { RandomSource } from './random.js';

/**
 * T-P-03：随机源抽象（NFR-04）。
 * TC-NFR-04-003：可注入确定性源（可测性保证）；默认实现必须是 CSPRNG 且无用户可控种子路径。
 */

const SAMPLES = 3000;

describe('CSPRNG 默认实现', () => {
  it('int(min, max) 为闭区间（crypto.randomInt 上界开，实现需 +1）', () => {
    const random = createCsprngRandom();
    const seen = new Set<number>();

    for (let i = 0; i < SAMPLES; i += 1) {
      const value = random.int(1, 6);
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(6);
      seen.add(value);
    }

    // 闭区间的关键证据：两端都出现过
    expect(seen).toContain(1);
    expect(seen).toContain(6);
  });

  it('命运骰区间 [-1, 1] 仅产出 -1 / 0 / 1', () => {
    const random = createCsprngRandom();

    for (let i = 0; i < SAMPLES; i += 1) {
      expect([-1, 0, 1]).toContain(random.int(-1, 1));
    }
  });

  it('min === max 时恒为该值', () => {
    expect(createCsprngRandom().int(5, 5)).toBe(5);
  });

  it('默认源不可预测（两次实例序列不同，无可复现种子）', () => {
    const a = createCsprngRandom();
    const b = createCsprngRandom();

    const seqA = Array.from({ length: 64 }, () => a.int(1, 100)).join(',');
    const seqB = Array.from({ length: 64 }, () => b.int(1, 100)).join(',');

    expect(seqA).not.toBe(seqB);
  });
});

describe('TC-NFR-04-003：确定性源注入', () => {
  it('注入固定序列后结果完全可预测', () => {
    const scripted: RandomSource = {
      int: (() => {
        const values = [3, 6, 1];
        let i = 0;
        return (): number => values[i++] ?? 0;
      })(),
    };

    const roll = rollDice('3d6', { random: scripted });

    expect(roll.rolls).toEqual([[3, 6, 1]]);
    expect(roll.total).toBe(10);
  });

  it('同一确定性源在重复调用下产出一致（回归可复现）', () => {
    const make = (): RandomSource => {
      let i = 0;
      const values = [10, 20, 30, 40];
      return { int: (): number => values[i++] ?? 0 };
    };

    expect(rollDice('2d100+2d100', { random: make() })).toEqual(
      rollDice('2d100+2d100', { random: make() }),
    );
  });
});
