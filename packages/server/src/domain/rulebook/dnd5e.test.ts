import { describe, expect, it } from 'vitest';
import { rollDice } from '../dice/evaluator.js';
import { DiceExpressionError } from '../dice/parser.js';
import type { RandomSource } from '../dice/random.js';
import { Dnd5eRuleBook } from './dnd5e.js';

/**
 * T-M7-02/06：D&D 5e 规则书（FR-20/21/22/23，设计文档 v2 §5.2）。
 * 判定向量：DC 边界、nat20/nat1 × nat20Rule 开关矩阵、kind 分流、adv/dis 展开、对抗检定。
 */

const book = new Dnd5eRuleBook();
const allD20 = new Dnd5eRuleBook({ nat20Rule: 'all_d20' });

/** 恒定骰源：所有骰都吐同一个值 */
const fixed = (value: number): RandomSource => ({ int: (): number => value });

/** 序列骰源：按序吐预置值（优劣势展开后的 2d20 需要两颗不同的骰） */
const seq = (...values: number[]): RandomSource => {
  let i = 0;
  return { int: (): number => values[i++] ?? 1 };
};

const roll = (
  expr: string,
  random: RandomSource,
  kind?: 'ability' | 'save' | 'attack' | 'initiative',
  rulebook = book,
) => rollDice(expr, { random, rulebook, kind: kind ?? 'ability' });

describe('规则书标识与能力面', () => {
  it('id 为 dnd5e', () => {
    expect(book.id).toBe('dnd5e');
  });

  it('5e 无理智规则：不实现 sanityRule', () => {
    expect((book as { sanityRule?: unknown }).sanityRule).toBeUndefined();
  });

  it('对抗检定：比 total，高者胜、相等为僵持', () => {
    expect(book.adjudicateOpposed({ roll: 18, skill: 0 }, { roll: 15, skill: 0 })).toEqual({
      winner: 'a',
    });
    expect(book.adjudicateOpposed({ roll: 11, skill: 0 }, { roll: 19, skill: 0 })).toEqual({
      winner: 'b',
    });
    expect(book.adjudicateOpposed({ roll: 14, skill: 0 }, { roll: 14, skill: 0 })).toEqual({
      winner: 'tie',
    });
  });
});

describe('DC 判定（FR-20：total ≥ DC）', () => {
  it('total 恰好等于 DC 即成功（边界内侧）', () => {
    expect(roll('1d20+5>=13', fixed(8)).check).toMatchObject({
      outcome: 'success',
      target: 13,
      op: '>=',
    });
  });

  it('total 差 1 即失败（边界外侧）', () => {
    expect(roll('1d20+5>=13', fixed(7)).check).toMatchObject({ outcome: 'fail', target: 13 });
  });

  it('DC 判定不带 grade（无规则书判定表语义）', () => {
    expect(roll('1d20+5>=13', fixed(8)).check?.grade).toBeUndefined();
  });

  it('豁免检定（kind=save）同样按 DC 判定', () => {
    expect(roll('1d20+2>=12', fixed(10), 'save').check).toMatchObject({
      outcome: 'success',
      kind: 'save',
    });
  });

  it('先攻（kind=initiative）无判定后缀 → 无 check，纯骰值', () => {
    const r = roll('1d20+3', fixed(11), 'initiative');
    expect(r.check).toBeNull();
    expect(r.total).toBe(14);
  });
});

describe('nat20 / nat1（FR-22 与 ADR-2-02 开关矩阵）', () => {
  it('攻击骰 nat20 → 大成功（必中），nat1 → 大失败（必失）', () => {
    expect(roll('1d20+5>=20', fixed(20), 'attack').check).toMatchObject({ outcome: 'critical' });
    expect(roll('1d20+5>=1', fixed(1), 'attack').check).toMatchObject({ outcome: 'fumble' });
  });

  it('nat1 即便加修正后够线也必失（官方口径，面值判定优先于 DC 比较）', () => {
    expect(roll('1d20+9>=5', fixed(1), 'attack').check).toMatchObject({ outcome: 'fumble' });
  });

  it('默认 attack_only：属性检定 nat20 只是普通成功，不是大成功', () => {
    expect(roll('1d20>=15', fixed(20), 'ability').check).toMatchObject({ outcome: 'success' });
    expect(roll('1d20>=15', fixed(20), 'ability').check?.outcome).not.toBe('critical');
  });

  it('默认 attack_only：属性检定 nat1 仍按 DC 判定，不额外判大失败', () => {
    expect(roll('1d20+5>=3', fixed(1), 'ability').check).toMatchObject({ outcome: 'success' });
  });

  it('all_d20 房规：所有 d20 检定都适用 nat20/nat1', () => {
    const r = rollDice('1d20>=25', {
      random: fixed(20),
      rulebook: allD20,
      kind: 'ability',
    });
    expect(r.check).toMatchObject({ outcome: 'critical' });

    const f = rollDice('1d20>=1', { random: fixed(1), rulebook: allD20, kind: 'save' });
    expect(f.check).toMatchObject({ outcome: 'fumble' });
  });

  it('加修正后到 25 不算 nat20：判定对象是主骰面值而非 total', () => {
    // 骰面 15 + 10 修正 = 25 ≥ DC 20，既非 nat20 也非 nat1，按普通成功
    expect(roll('1d20+10>=20', fixed(15), 'attack').check).toMatchObject({ outcome: 'success' });
  });

  it('多骰组无明确主骰时不触发面值规则（raw 为 null）', () => {
    expect(roll('1d20+1d4>=15', seq(20, 1), 'attack').check).toMatchObject({ outcome: 'success' });
  });
});

describe('优势 / 劣势（FR-23：adv / dis 展开为 2d20kh1 / 2d20kl1）', () => {
  it('adv 取高：expr 记录展开后的骰式，kept 为保留的那颗', () => {
    const r = roll('1d20+5>=13 adv', seq(3, 18), 'attack');
    expect(r.expr).toBe('2d20kh1+5>=13');
    expect(r.rolls).toEqual([[3, 18]]);
    expect(r.kept).toEqual([18]);
    expect(r.total).toBe(23);
    expect(r.check).toMatchObject({ outcome: 'success' });
  });

  it('dis 取低：保留较低那颗', () => {
    const r = roll('1d20+5>=13 dis', seq(3, 18), 'attack');
    expect(r.expr).toBe('2d20kl1+5>=13');
    expect(r.kept).toEqual([3]);
    expect(r.total).toBe(8);
    expect(r.check).toMatchObject({ outcome: 'fail' });
  });

  it('优势下保留到 20 即触发 nat20（判定用被保留的那颗）', () => {
    const r = roll('1d20>=20 adv', seq(20, 5), 'attack');
    expect(r.kept).toEqual([20]);
    expect(r.check).toMatchObject({ outcome: 'critical' });
  });

  it('劣势下保留到 1 即触发 nat1', () => {
    const r = roll('1d20>=1 dis', seq(1, 19), 'attack');
    expect(r.kept).toEqual([1]);
    expect(r.check).toMatchObject({ outcome: 'fumble' });
  });

  it('adv / dis 只能用于含单颗 d20 的骰式（1d100 adv → E-DICE-01）', () => {
    expect(() => rollDice('1d100<=50 adv', { random: fixed(10), rulebook: book })).toThrow(
      DiceExpressionError,
    );
  });

  it('已被取舍的 d20 不可再加 adv（2d20kh1 adv → E-DICE-01）', () => {
    expect(() => rollDice('2d20kh1>=13 adv', { random: fixed(10), rulebook: book })).toThrow(
      DiceExpressionError,
    );
  });
});

describe('parseCheck（规则书自解判定规格）', () => {
  it('DC 后缀产出 >= 判定规格，kind 缺省为属性检定', () => {
    expect(book.parseCheck('1d20+5>=13', {})).toMatchObject({
      check: { kind: 'ability', target: 13, op: '>=' },
    });
  });

  it('无判定后缀（先攻）返回 null', () => {
    expect(book.parseCheck('1d20+3', { kind: 'initiative' })).toBeNull();
  });
});
