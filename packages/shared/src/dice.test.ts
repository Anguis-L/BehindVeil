import { describe, expect, it } from 'vitest';
import {
  CHECK_OPS,
  DICE_KINDS,
  DEFAULT_NAT20_RULE,
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

  it('枚举无重复（运行时常量与类型保持同步）', () => {
    const all: DiceKind[] = [...DICE_KINDS];
    expect(new Set(all).size).toBe(DICE_KINDS.length);
  });

  it('规则书标识含 coc7 与 dnd5e', () => {
    expect(RULEBOOK_IDS).toEqual(['coc7', 'dnd5e']);
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
});
