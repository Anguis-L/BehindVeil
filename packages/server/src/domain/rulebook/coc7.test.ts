import { describe, expect, it } from 'vitest';
import { rollDice } from '../dice/evaluator.js';
import type { RandomSource } from '../dice/random.js';
import { Coc7RuleBook, DEFAULT_COC7_HOUSE_RULES } from './coc7.js';

/**
 * T-P-04：COC7 规则书（TDD §5.3 判定表 = TC-FR-04-007~015 验收基准）。
 * 判定顺序：大成功 → 大失败 → 极难 → 困难 → 普通 → 失败；KP 难度档未达按失败计。
 * 房规可配：criticalMax(1–5)、大失败阈值、理智损失表。
 */

const book = new Coc7RuleBook();

const judge = (
  roll: number,
  target: number,
  difficulty: 'normal' | 'hard' | 'extreme' = 'normal',
) => book.adjudicate(roll, { kind: 'skill', target, difficulty });

const fixed = (value: number): RandomSource => ({ int: (): number => value });

describe('规则书标识', () => {
  it('id 为 coc7', () => {
    expect(book.id).toBe('coc7');
  });
});

describe('TC-FR-04-010：大成功', () => {
  it('roll=01 即大成功', () => {
    expect(judge(1, 60)).toEqual({ outcome: 'critical', grade: 'normal' });
  });

  it('房规 criticalMax=5 时 02–05 亦为大成功，06 不再是大成功', () => {
    const house = new Coc7RuleBook({ criticalMax: 5 });

    expect(house.adjudicate(5, { kind: 'skill', target: 60, difficulty: 'normal' })).toMatchObject({
      outcome: 'critical',
    });
    expect(
      house.adjudicate(6, { kind: 'skill', target: 60, difficulty: 'normal' }),
    ).not.toMatchObject({ outcome: 'critical' });
  });

  it('criticalMax 仅限 1–5，越界即拒绝', () => {
    for (const criticalMax of [0, 6, 1.5, -1]) {
      expect(() => new Coc7RuleBook({ criticalMax }), `criticalMax=${criticalMax}`).toThrow(
        RangeError,
      );
    }
  });
});

describe('TC-FR-04-011：极难成功（roll ≤ 技能/5）', () => {
  it('边界值两侧正确（技能 60 → 阈值 12）', () => {
    expect(judge(12, 60)).toEqual({ outcome: 'success', grade: 'extreme' });
    expect(judge(13, 60)).toEqual({ outcome: 'success', grade: 'hard' });
  });
});

describe('TC-FR-04-012：困难成功（roll ≤ 技能/2）', () => {
  it('边界值两侧正确（技能 60 → 阈值 30）', () => {
    expect(judge(30, 60)).toEqual({ outcome: 'success', grade: 'hard' });
    expect(judge(31, 60)).toEqual({ outcome: 'success', grade: 'normal' });
  });
});

describe('TC-FR-04-013：普通成功（roll ≤ 技能）', () => {
  it('边界值两侧正确', () => {
    expect(judge(60, 60)).toEqual({ outcome: 'success', grade: 'normal' });
    expect(judge(61, 60)).toEqual({ outcome: 'fail', grade: 'normal' });
  });
});

describe('TC-FR-04-014：大失败', () => {
  it('技能 <50：roll ≥ 96', () => {
    expect(judge(96, 40)).toEqual({ outcome: 'fumble', grade: 'normal' });
    expect(judge(95, 40)).toEqual({ outcome: 'fail', grade: 'normal' });
  });

  it('技能 ≥50：roll = 100', () => {
    expect(judge(100, 50)).toEqual({ outcome: 'fumble', grade: 'normal' });
    expect(judge(99, 50)).toEqual({ outcome: 'fail', grade: 'normal' });
  });

  it('房规阈值可配', () => {
    const low = new Coc7RuleBook({ fumbleLowSkill: 90 });
    expect(low.adjudicate(90, { kind: 'skill', target: 40, difficulty: 'normal' })).toMatchObject({
      outcome: 'fumble',
    });

    const high = new Coc7RuleBook({ fumbleHighSkill: 98 });
    expect(high.adjudicate(98, { kind: 'skill', target: 50, difficulty: 'normal' })).toMatchObject({
      outcome: 'fumble',
    });
  });
});

describe('KP 难度档（difficulty）', () => {
  it('困难档未达即失败（技能 60 → 阈值 30）', () => {
    expect(judge(30, 60, 'hard')).toEqual({ outcome: 'success', grade: 'hard' });
    expect(judge(31, 60, 'hard')).toEqual({ outcome: 'fail', grade: 'normal' });
  });

  it('极难档未达即失败，但保留已达成的自然档位（技能 60 → 阈值 12）', () => {
    expect(judge(12, 60, 'extreme')).toEqual({ outcome: 'success', grade: 'extreme' });
    // roll=20 的自然档是「困难」（≤30），未达极难要求 → 判失败但 grade 仍是 hard
    expect(judge(20, 60, 'extreme')).toEqual({ outcome: 'fail', grade: 'hard' });
  });
});

describe('TC-FR-04-007：幸运检定（kind=luck）', () => {
  it('roll ≤ 幸运值即成功，边界正确', () => {
    const roll = (value: number) =>
      rollDice('1d100<=60', { random: fixed(value), rulebook: book, kind: 'luck' });

    expect(roll(60).check).toMatchObject({ kind: 'luck', outcome: 'success' });
    expect(roll(61).check).toMatchObject({ kind: 'luck', outcome: 'fail' });
    expect(roll(1).check).toMatchObject({ kind: 'luck', outcome: 'critical' });
  });
});

describe('TC-FR-04-008：对抗检定', () => {
  it('成功等级高者胜（大成功 > 普通成功）', () => {
    expect(book.adjudicateOpposed?.({ roll: 1, skill: 50 }, { roll: 40, skill: 50 })).toEqual({
      winner: 'a',
    });
  });

  it('一方失败一方成功 → 成功方胜', () => {
    expect(book.adjudicateOpposed?.({ roll: 90, skill: 50 }, { roll: 40, skill: 50 })).toEqual({
      winner: 'b',
    });
  });

  it('双方均失败 → 平', () => {
    expect(book.adjudicateOpposed?.({ roll: 90, skill: 50 }, { roll: 91, skill: 50 })).toEqual({
      winner: 'tie',
    });
  });

  it('等级相同 → 技能值高者胜', () => {
    expect(book.adjudicateOpposed?.({ roll: 40, skill: 50 }, { roll: 30, skill: 70 })).toEqual({
      winner: 'b',
    });
  });

  it('等级与技能值都相同 → 平', () => {
    expect(book.adjudicateOpposed?.({ roll: 40, skill: 50 }, { roll: 30, skill: 50 })).toEqual({
      winner: 'tie',
    });
  });

  it('极难成功胜过困难成功', () => {
    expect(book.adjudicateOpposed?.({ roll: 2, skill: 60 }, { roll: 25, skill: 60 })).toEqual({
      winner: 'a',
    });
  });
});

describe('TC-FR-04-015：理智损失（sanityRule）', () => {
  it('按判定等级查表输出损失表达式与描述', () => {
    expect(book.sanityRule?.(1, 65)).toEqual({
      loss: DEFAULT_COC7_HOUSE_RULES.sanityLossTable.critical,
      desc: '大成功：损失 0',
    });
    expect(book.sanityRule?.(40, 65)).toEqual({
      loss: DEFAULT_COC7_HOUSE_RULES.sanityLossTable.normal,
      desc: '普通成功：损失 1d2',
    });
    expect(book.sanityRule?.(80, 65)).toEqual({
      loss: DEFAULT_COC7_HOUSE_RULES.sanityLossTable.fail,
      desc: '失败：损失 1d6',
    });
  });

  it('大失败按当前 SAN 分档（SAN≥50 时 100 才大失败；SAN<50 时 96 即大失败）', () => {
    expect(book.sanityRule?.(100, 65)).toMatchObject({
      loss: DEFAULT_COC7_HOUSE_RULES.sanityLossTable.fumble,
    });
    expect(book.sanityRule?.(96, 40)).toMatchObject({
      loss: DEFAULT_COC7_HOUSE_RULES.sanityLossTable.fumble,
    });
  });

  it('损失表可房规配置', () => {
    const house = new Coc7RuleBook({
      sanityLossTable: { ...DEFAULT_COC7_HOUSE_RULES.sanityLossTable, fail: '1d4' },
    });

    expect(house.sanityRule?.(80, 65)).toMatchObject({ loss: '1d4' });
  });
});

describe('parseCheck（TDD §5.3）', () => {
  it('带判定后缀的表达式产出判定规格', () => {
    const parsed = book.parseCheck('1d100<=50');

    expect(parsed?.expr.canonical).toBe('1d100<=50');
    expect(parsed?.check).toEqual({ kind: 'skill', target: 50, difficulty: 'normal' });
  });

  it('上下文可指定 kind 与 difficulty', () => {
    const parsed = book.parseCheck('1d100<=50', { kind: 'sanity', difficulty: 'hard' });

    expect(parsed?.check).toEqual({ kind: 'sanity', target: 50, difficulty: 'hard' });
  });

  it('无判定后缀时返回 null', () => {
    expect(book.parseCheck('1d100')).toBeNull();
  });
});
