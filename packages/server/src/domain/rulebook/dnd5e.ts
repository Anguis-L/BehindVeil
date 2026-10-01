import {
  DEFAULT_NAT20_RULE,
  type CheckDifficulty,
  type Dnd5eAbility,
  type Dnd5eSheet,
  type Nat20Rule,
} from '@behindveil/shared';
import { parseDiceExpr } from '../dice/parser.js';
import type {
  AdjudicateInput,
  CheckResult,
  CheckSpec,
  OpposedResult,
  OpposedSide,
  ParsedCheck,
  RollContext,
  RuleBook,
} from './types.js';

/**
 * D&D 5e 规则书（v2 FR-20/21/22/23，设计文档 v2 §5.2）。
 *
 * 判定语义：
 * - DC 检定（`1d20+修正>=DC`，kind=ability/save）：total ≥ DC 成功，否则失败；不带 grade；
 * - 攻击（`>=AC`，kind=attack）：同上，且 nat20 → critical（必中）、nat1 → fumble（必失）；
 * - nat20/nat1 适用面由会话设置 nat20Rule 决定（ADR-2-02）：
 *   attack_only（默认，官方口径）仅攻击骰；all_d20 为常见桌面房规；
 * - 判定对象是 raw（主骰面值）而非 total——加了 5 点修正的 25 不算 nat20；
 * - 先攻（kind=initiative）无判定后缀，parseCheck 返回 null，纯骰值由主持排序；
 * - 优势/劣势（FR-23）：骰式末尾 `adv` / `dis`，求值器展开为 2d20kh1 / 2d20kl1（见 parser/evaluator）。
 *
 * 5e 无理智规则，故不实现 sanityRule（可选能力留空）。
 */
export interface Dnd5eOptions {
  /** nat20/nat1 适用面；缺省 attack_only（DEFAULT_NAT20_RULE） */
  nat20Rule?: Nat20Rule;
}

/**
 * 技能 → 属性对照（SRD 机制数据，无版权问题；内容描述不进代码，见 ADR-2-05）。
 * 键为规范化技能名（小写、去空格与连字符），中文别名一并收录——AI 多半给中文技能名。
 */
export const DND5E_SKILL_ABILITY: Record<string, Dnd5eAbility> = {
  athletics: 'str',
  运动: 'str',
  acrobatics: 'dex',
  杂技: 'dex',
  sleightofhand: 'dex',
  戏法: 'dex',
  stealth: 'dex',
  隐匿: 'dex',
  arcana: 'int',
  奥秘: 'int',
  history: 'int',
  历史: 'int',
  investigation: 'int',
  调查: 'int',
  nature: 'int',
  自然: 'int',
  religion: 'int',
  宗教: 'int',
  animalhandling: 'wis',
  驯兽: 'wis',
  insight: 'wis',
  洞察: 'wis',
  medicine: 'wis',
  医药: 'wis',
  perception: 'wis',
  察觉: 'wis',
  survival: 'wis',
  生存: 'wis',
  deception: 'cha',
  欺瞒: 'cha',
  intimidation: 'cha',
  威吓: 'cha',
  performance: 'cha',
  表演: 'cha',
  persuasion: 'cha',
  说服: 'cha',
};

/** 六维中文名与英文键（属性名本身也可当检定项，如 AI 直接说「力量」） */
export const DND5E_ABILITY_ALIASES: Record<string, Dnd5eAbility> = {
  str: 'str',
  力量: 'str',
  dex: 'dex',
  敏捷: 'dex',
  con: 'con',
  体质: 'con',
  int: 'int',
  智力: 'int',
  wis: 'wis',
  感知: 'wis',
  cha: 'cha',
  魅力: 'cha',
};

/** KP 未给 DC 时按难度档的默认 DC（5e 官方：容易 5 / 中等 10 / 困难 15 / 极难 20） */
export const DND5E_DEFAULT_DC: Record<CheckDifficulty, number> = {
  normal: 10,
  hard: 15,
  extreme: 20,
};

/** 属性调整值 = floor((属性值 − 10) / 2) */
export function abilityModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

/** 技能名规范化：小写、去空格与连字符（让「Sleight of Hand」「sleight-of-hand」「戏法」都能命中） */
export function normalizeSkillKey(skill: string): string {
  return skill
    .trim()
    .toLowerCase()
    .replace(/[\s_-]/g, '');
}

/**
 * 5e 技能修正值（服务端现算，AI 与客户端都不传数值——FR-24 红线）：
 * 属性调整值 +（熟练 ? 熟练加值 : 0）。
 * 技能名既可以是技能（含中文），也可以是六维本身（力量/str）。认不出返回 null（归 E-AI-01）。
 */
export function dnd5eSkillModifier(sheet: Dnd5eSheet, skill: string): number | null {
  const key = normalizeSkillKey(skill);
  const ability = DND5E_SKILL_ABILITY[key] ?? DND5E_ABILITY_ALIASES[key];
  if (!ability) return null;
  const mod = abilityModifier(sheet.abilities[ability]);
  const proficient = sheet.proficientSkills.some((s) => normalizeSkillKey(s) === key);
  return mod + (proficient ? sheet.proficiencyBonus : 0);
}

/** 5e 豁免修正值：属性调整值 +（该属性熟练 ? 熟练加值 : 0） */
export function dnd5eSaveModifier(sheet: Dnd5eSheet, ability: Dnd5eAbility): number {
  const mod = abilityModifier(sheet.abilities[ability]);
  return mod + (sheet.proficientSaves.includes(ability) ? sheet.proficiencyBonus : 0);
}

export class Dnd5eRuleBook implements RuleBook {
  readonly id = 'dnd5e' as const;
  readonly defaultKind = 'ability' as const;

  readonly nat20Rule: Nat20Rule;

  constructor(options: Dnd5eOptions = {}) {
    this.nat20Rule = options.nat20Rule ?? DEFAULT_NAT20_RULE;
  }

  /** 5e 的 DC/AC 判定后缀为 `>=`；无后缀（如先攻 `1d20+3`）返回 null——纯骰值，无判定 */
  parseCheck(expr: string, ctx: RollContext = {}): ParsedCheck | null {
    const parsed = parseDiceExpr(expr);
    if (!parsed.check) return null;
    return {
      expr: parsed,
      check: {
        kind: ctx.kind ?? 'ability',
        target: parsed.check.target,
        difficulty: ctx.difficulty ?? 'normal',
        op: parsed.check.op,
      },
    };
  }

  adjudicate(roll: AdjudicateInput, spec: CheckSpec): CheckResult {
    // 面值规则优先于 DC 比较：nat1 即便加修正后够线也必失（官方口径）
    if (this.natApplies(spec.kind) && roll.raw === 20) {
      return { outcome: 'critical', grade: 'normal' };
    }
    if (this.natApplies(spec.kind) && roll.raw === 1) {
      return { outcome: 'fumble', grade: 'normal' };
    }

    const op = spec.op ?? '>=';
    const passed =
      op === '<='
        ? roll.total <= spec.target
        : op === '='
          ? roll.total === spec.target
          : roll.total >= spec.target;
    return { outcome: passed ? 'success' : 'fail', grade: 'normal' };
  }

  /**
   * 对抗检定（FR-20）：比 total（双方 d20 + 各自修正），高者胜，相等为僵持（tie）。
   * 5e 对抗不看成功等级，故 OpposedSide.roll 传入的是该方 total。
   */
  adjudicateOpposed(a: OpposedSide, b: OpposedSide): OpposedResult {
    if (a.roll === b.roll) return { winner: 'tie' };
    return { winner: a.roll > b.roll ? 'a' : 'b' };
  }

  private natApplies(kind: CheckSpec['kind']): boolean {
    return this.nat20Rule === 'all_d20' || kind === 'attack';
  }
}
