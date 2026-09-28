import { describe, expect, it } from 'vitest';
import { Coc7RuleBook } from '../rulebook/coc7.js';
import { DiceExpressionError } from './parser.js';
import type { RandomSource } from './random.js';
import { replayRoll, rollDice } from './evaluator.js';

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

  it('缺省运算符记为 <=（规则书判定表路径）', () => {
    const roll = rollDice('1d100<=50', { random: seq(42), rulebook: coc7 });

    expect(roll.check).toMatchObject({ op: '<=', grade: 'normal' });
  });

  it('无判定后缀时即使给了规则书也不产出 check', () => {
    expect(rollDice('1d100', { random: seq(42), rulebook: coc7 }).check).toBeNull();
  });
});

describe('判定运算符 >= / =（2026-09-25 拍板方案 a，T-M4-02）', () => {
  it('1d20+5>=13 达标为 success，且不查 COC7 判定表（无 grade）', () => {
    const roll = rollDice('1d20+5>=13', { random: seq(10), rulebook: coc7 });

    expect(roll.total).toBe(15);
    // toMatchObject：只断言关心的字段，后续给 check 加字段时不必改测试
    expect(roll.check).toMatchObject({
      rulebook: 'coc7',
      kind: 'skill',
      target: 13,
      difficulty: 'normal',
      op: '>=',
      outcome: 'success',
    });
  });

  it('>= 未达标为 fail（同样不带 grade）', () => {
    const roll = rollDice('1d20+5>=13', { random: seq(2), rulebook: coc7 });

    expect(roll.total).toBe(7);
    expect(roll.check).toMatchObject({ op: '>=', outcome: 'fail' });
    expect(roll.check?.grade).toBeUndefined();
  });

  it('= 为等值判定：相等 success、不等 fail', () => {
    const hit = rollDice('1d6=3', { random: seq(3), rulebook: coc7 });
    const miss = rollDice('1d6=3', { random: seq(5), rulebook: coc7 });

    expect(hit.check).toMatchObject({ op: '=', outcome: 'success' });
    expect(miss.check).toMatchObject({ op: '=', outcome: 'fail' });
  });

  it('>= 与 <= 同值时方向不同（运算符不再被丢弃）', () => {
    // total=50：<=50 走 COC7 表判成功；>=50 布尔比较也成功，但语义与产物不同
    const le = rollDice('1d100<=50', { random: seq(50), rulebook: coc7 });
    const ge = rollDice('1d100>=50', { random: seq(50), rulebook: coc7 });

    expect(le.check).toMatchObject({ op: '<=', outcome: 'success', grade: 'normal' });
    expect(ge.check).toMatchObject({ op: '>=', outcome: 'success' });
    expect(ge.check?.grade).toBeUndefined();
  });

  it('>= 也要求装配规则书（判定权威必须明确）', () => {
    expect(() => rollDice('1d20+5>=13', { random: seq(10) })).toThrow(DiceExpressionError);
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

  it('骰值多于表达式所需：复现报数量不符（不许拿多余值蒙混）', () => {
    // expr 只需 1 个骰值，流水却给了 3 个 → 重放后消耗数与提供数不等
    expect(() => replayRoll('1d100', [[1], [2], [3]])).toThrow(/需要 1 个骰值，流水给了 3 个/);
  });

  it('骰值少于表达式所需：重放当场失败（不许拿别的值凑）', () => {
    // expr 要 2 个骰值、流水只给 1 个：重放源在第二颗骰子处就断了
    expect(() => replayRoll('2d6', [[1]])).toThrow(/原始骰值不足以重放该表达式/);
  });

  it('骰值超出骰面值域：复现报越界（防篡改流水凑出相同 total）', () => {
    // 1d100 给了 150：即便 total 碰巧一致也不允许通过
    expect(() => replayRoll('1d100', [[150]])).toThrow(/超出 1–100 值域/);
    // dF 值域 {-1,0,1}，给了 2 同样越界
    expect(() => replayRoll('4dF', [[1, 0, 2, -1]])).toThrow(/超出 -1–1 值域/);
    // 边界值合法
    expect(() => replayRoll('1d100', [[100]])).not.toThrow();
  });

  it('total 可由 rolls 与表达式重算（审计复现的前提）', () => {
    const roll = rollDice('2d6kh1+3', { random: seq(5, 2) });

    const highest = Math.max(...(roll.rolls[0] ?? []));
    expect(roll.total).toBe(highest + 3);
  });
});
