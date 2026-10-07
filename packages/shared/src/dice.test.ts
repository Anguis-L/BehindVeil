import { describe, expect, it } from 'vitest';
import {
  CHECK_OPS,
  DICE_KINDS,
  DEFAULT_NAT20_RULE,
  GenericRuleSchema,
  NAT20_RULES,
  RULEBOOK_IDS,
  RollCheckSchema,
  type DiceKind,
} from './dice.js';

/**
 * 骰子契约（T-M7-01，v2 FR-21/22）：枚举即跨端契约——加值不影响既有取值，
 * 前端按枚举渲染天然跟随；判定记录要能带上 nat20 开关，否则审计复现算不回原结果。
 */

describe('判定种类与规则书标识', () => {
  it('v1 的 COC 四种不受影响（加值不加减）', () => {
    expect(DICE_KINDS.slice(0, 4)).toEqual(['skill', 'sanity', 'opposed', 'luck']);
  });

  it('v2 追加 5e 四种：属性检定 / 豁免 / 攻击 / 先攻', () => {
    expect(DICE_KINDS).toContain('ability');
    expect(DICE_KINDS).toContain('save');
    expect(DICE_KINDS).toContain('attack');
    expect(DICE_KINDS).toContain('initiative');
  });

  it('v3 追加 generic 缺省种类：check（映射表外原值直显）', () => {
    expect(DICE_KINDS).toContain('check');
  });

  it('枚举无重复（运行时常量与类型保持同步）', () => {
    const all: DiceKind[] = [...DICE_KINDS];
    expect(new Set(all).size).toBe(DICE_KINDS.length);
  });

  it('规则书标识含 coc7 / dnd5e / generic（v3 FR-40 第三实现）', () => {
    expect(RULEBOOK_IDS).toEqual(['coc7', 'dnd5e', 'generic']);
  });
});

describe('判定运算符与 nat20 开关', () => {
  it('判定后缀三种运算符', () => {
    expect(CHECK_OPS).toEqual(['<=', '>=', '=']);
  });

  it('nat20 默认口径 = 仅攻击骰（官方）', () => {
    expect(NAT20_RULES).toEqual(['attack_only', 'all_d20']);
    expect(DEFAULT_NAT20_RULE).toBe('attack_only');
  });

  it('判定记录可带 nat20Rule（复现凭据）', () => {
    const parsed = RollCheckSchema.parse({
      rulebook: 'dnd5e',
      kind: 'attack',
      target: 16,
      difficulty: 'normal',
      outcome: 'critical',
      op: '>=',
      nat20Rule: 'all_d20',
    });
    expect(parsed.nat20Rule).toBe('all_d20');
  });

  it('判定记录不带 nat20Rule 也合法（v1 存量流水 / COC）', () => {
    const parsed = RollCheckSchema.parse({
      rulebook: 'coc7',
      kind: 'skill',
      target: 60,
      difficulty: 'normal',
      outcome: 'success',
      grade: 'hard',
    });
    expect(parsed.nat20Rule).toBeUndefined();
  });

  it('判定记录可带 generic 档表快照（复现凭据，v3 FR-40）', () => {
    const parsed = RollCheckSchema.parse({
      rulebook: 'generic',
      kind: 'check',
      target: 7,
      difficulty: 'normal',
      outcome: 'critical',
      op: '>=',
      genericGrades: [{ name: 'critical', when: 'total>=10' }],
    });
    expect(parsed.genericGrades).toEqual([{ name: 'critical', when: 'total>=10' }]);
  });
});

describe('GenericRuleSchema（generic 规则书配置，v3 FR-40）', () => {
  it('最小配置：仅 dice，其余走缺省（op >= / kinds [check] / 平局僵持 / 无理智）', () => {
    const parsed = GenericRuleSchema.parse({ dice: '2d6' });
    expect(parsed.op).toBe('>=');
    expect(parsed.kinds).toEqual(['check']);
    expect(parsed.opposedTie).toBe('tie');
    expect(parsed.sanityRule).toBe(false);
    expect(parsed.grades).toBeUndefined();
  });

  it('设计 §5.5 示例配置全量可解析', () => {
    const parsed = GenericRuleSchema.parse({
      dice: '1d20',
      op: '>=',
      kinds: ['check', 'save'],
      grades: [
        { name: 'critical', when: 'raw>=20' },
        { name: 'fumble', when: 'raw<=1' },
      ],
      opposedTie: 'attacker',
      sanityRule: false,
    });
    expect(parsed.grades).toHaveLength(2);
  });

  it('拒收未知判定种类（kinds 是 DICE_KINDS 子集，审计记录才装得下）', () => {
    expect(() => GenericRuleSchema.parse({ dice: '1d20', kinds: ['boggle'] })).toThrow();
  });

  it('拒收 sanityRule:true（generic 不绑定理智规则）', () => {
    expect(() => GenericRuleSchema.parse({ dice: '1d20', sanityRule: true })).toThrow();
  });

  it('拒收档表名出判定四分类（name 是 outcome，非自由展示串）', () => {
    expect(() =>
      GenericRuleSchema.parse({ dice: '1d20', grades: [{ name: 'partial', when: 'total>=7' }] }),
    ).toThrow();
  });

  it('拒收空 kinds 与超量档表', () => {
    expect(() => GenericRuleSchema.parse({ dice: '1d20', kinds: [] })).toThrow();
    const nine = Array.from({ length: 9 }, (_, i) => ({ name: 'success', when: `total>=${i}` }));
    expect(() => GenericRuleSchema.parse({ dice: '1d20', grades: nine })).toThrow();
  });
});
