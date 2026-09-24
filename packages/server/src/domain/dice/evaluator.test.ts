import { describe, expect, it } from 'vitest';
import { Coc7RuleBook } from '../rulebook/coc7.js';
import { DiceExpressionError } from './parser.js';
import type { RandomSource } from './random.js';
import { rollDice } from './evaluator.js';

/**
 * T-P-02：求值器（TDD §5.3）。
 * 对应 TC-FR-04-001~005、009：rolls/kept/total 语义、修改器、命运骰、判定后缀。
 * 随机源一律注入确定性序列（TC-NFR-04-003），保证可复现。
 */

/** 顺序吐出预设值的确定性随机源 */
function seq(...values: number[]): RandomSource & { calls: number } {
  let i = 0;
  return {
    calls: 0,
    int(): number {
      this.calls += 1;
      return values[i++] ?? 1;
    },
  };
}

const coc7 = new Coc7RuleBook();

describe('基础掷骰（TC-FR-04-001）', () => {
  it('1d100 记录单组原始骰值', () => {
    const roll = rollDice('1d100', { random: seq(42) });

    expect(roll.expr).toBe('1d100');
    expect(roll.rolls).toEqual([[42]]);
    expect(roll.kept).toEqual([42]);
    expect(roll.total).toBe(42);
    expect(roll.check).toBeNull();
  });

  it('2d6 求和，骰值按组保留', () => {
    const roll = rollDice('2d6', { random: seq(3, 5) });

    expect(roll.rolls).toEqual([[3, 5]]);
    expect(roll.total).toBe(8);
  });

  it('多骰组各自成组（审计重算需要分组信息）', () => {
    const roll = rollDice('2d6+1d10', { random: seq(1, 2, 3) });

    expect(roll.rolls).toEqual([[1, 2], [3]]);
    expect(roll.total).toBe(6);
  });
});

describe('四则运算（TC-FR-04-002）', () => {
  it('3d6+2d10-1*2 遵循中缀优先级', () => {
    const roll = rollDice('3d6+2d10-1*2', { random: seq(1, 2, 3, 4, 5) });

    expect(roll.rolls).toEqual([
      [1, 2, 3],
      [4, 5],
    ]);
    expect(roll.kept).toEqual([1, 2, 3, 4, 5]);
    expect(roll.total).toBe(6 + 9 - 2);
  });

  it('除法向零取整（保证 total 恒为整数且可复现）', () => {
    expect(rollDice('7/2', { random: seq() }).total).toBe(3);
    expect(rollDice('0-7/2', { random: seq() }).total).toBe(-3); // trunc(-3.5) = -3，不是 -4
  });
});

describe('修改器 kh/kl/dh/dl（TC-FR-04-003）', () => {
  it('kh3 保留最高的 3 个', () => {
    const roll = rollDice('4d6kh3', { random: seq(1, 6, 3, 2) });

    expect(roll.rolls).toEqual([[1, 6, 3, 2]]); // 原始值完整留痕
    expect(roll.kept).toEqual([6, 3, 2]);
    expect(roll.total).toBe(11);
  });

  it('kl2 保留最低的 2 个', () => {
    expect(rollDice('4d6kl2', { random: seq(1, 6, 3, 2) }).kept).toEqual([1, 2]);
  });

  it('dh1 弃置最高的 1 个', () => {
    expect(rollDice('4d6dh1', { random: seq(1, 6, 3, 2) }).kept).toEqual([3, 2, 1]);
  });

  it('dl1 弃置最低的 1 个', () => {
    expect(rollDice('4d6dl1', { random: seq(1, 6, 3, 2) }).kept).toEqual([2, 3, 6]);
  });

  it('修改器数量超过骰数时全部保留', () => {
    const roll = rollDice('2d6kh5', { random: seq(4, 1) });

    expect(roll.kept).toEqual([4, 1]);
    expect(roll.total).toBe(5);
  });
});

describe('命运骰 dF（TC-FR-04-004）', () => {
  it('值域为 {-1, 0, +1} 且按原始值留痕', () => {
    const roll = rollDice('4dF', { random: seq(-1, 0, 1, 1) });

    expect(roll.rolls).toEqual([[-1, 0, 1, 1]]);
    for (const value of roll.rolls[0] ?? []) {
      expect([-1, 0, 1]).toContain(value);
    }
    expect(roll.total).toBe(1);
  });
});

describe('判定后缀（TC-FR-04-005 / 009）', () => {
  it('1d100<=50 生成 COC7 判定记录', () => {
    const roll = rollDice('1d100<=50', { random: seq(42), rulebook: coc7 });

    expect(roll.check).toMatchObject({
      rulebook: 'coc7',
      kind: 'skill',
      target: 50,
      difficulty: 'normal',
      outcome: 'success',
    });
    expect(roll.total).toBe(42);
  });

  it('组合表达式按 total 比对判定目标（2d6+3<=8）', () => {
    const roll = rollDice('2d6+3<=8', { random: seq(2, 3), rulebook: coc7 });

    expect(roll.total).toBe(8);
    expect(roll.check).toMatchObject({ target: 8, outcome: 'success' });
  });

  it('kind 与 difficulty 透传到判定记录（luck / hard）', () => {
    const roll = rollDice('1d100<=50', {
      random: seq(10),
      rulebook: coc7,
      kind: 'luck',
      difficulty: 'hard',
    });

    expect(roll.check).toMatchObject({
      kind: 'luck',
      difficulty: 'hard',
      outcome: 'success',
      grade: 'extreme',
    });
  });

  it('未提供规则书时拒绝带判定后缀的表达式（判定权威必须明确）', () => {
    expect(() => rollDice('1d100<=50', { random: seq(42) })).toThrow(DiceExpressionError);
  });

  it('无判定后缀时即使给了规则书也不产出 check', () => {
    expect(rollDice('1d100', { random: seq(42), rulebook: coc7 }).check).toBeNull();
  });
});

describe('失败路径不得消耗随机数（TC-FR-04-006）', () => {
  it('静态除零被前置拒绝，不掷骰', () => {
    const random = seq();

    expect(() => rollDice('6/0', { random })).toThrow(DiceExpressionError);
    expect(random.calls).toBe(0);
  });

  it('非法表达式不掷骰', () => {
    const random = seq();

    expect(() => rollDice('0d6', { random })).toThrow(DiceExpressionError);
    expect(random.calls).toBe(0);
  });
});

describe('可复现性（D-04：expr + rolls 可重算）', () => {
  it('相同骰值序列 → 相同产物', () => {
    const a = rollDice('3d6+2', { random: seq(2, 4, 6) });
    const b = rollDice('3d6+2', { random: seq(2, 4, 6) });

    expect(a).toEqual(b);
  });

  it('total 可由 rolls 与表达式重算（审计复现的前提）', () => {
    const roll = rollDice('2d6kh1+3', { random: seq(5, 2) });

    const highest = Math.max(...(roll.rolls[0] ?? []));
    expect(roll.total).toBe(highest + 3);
  });
});
