import type { CheckGrade } from '@behindveil/shared';
import { parseDiceExpr } from '../dice/parser.js';
import type {
  CheckResult,
  CheckSpec,
  OpposedResult,
  OpposedSide,
  ParsedCheck,
  RollContext,
  RuleBook,
  SanityLoss,
} from './types.js';

/**
 * COC7 规则书（T-P-04，TDD §5.3 判定表 = TC-FR-04-007~015 验收基准）。
 *
 * 判定顺序：大成功 → 大失败 → 极难 → 困难 → 普通 → 失败（先到先判）。
 * 房规可配：critical 命中 1–5；大失败阈值按技能 <50 / ≥50 分档（96/100）。
 * KP 要求的难度档（difficulty）抬高成功线：未达档位按失败计（如「困难侦查」要求 ≤ 技能/2）。
 * 理智损失按判定等级查表——默认表为常见速查房规，KP 可配（T-M5-08 消费）。
 */

/** 理智损失表键：按判定等级（critical/fumble/fail 及 success 的三档子等级） */
export type SanityLevelKey = 'critical' | 'extreme' | 'hard' | 'normal' | 'fail' | 'fumble';

export interface Coc7HouseRules {
  /** 大成功阈值：roll ≤ criticalMax（房规 1–5，默认 1） */
  criticalMax: number;
  /** 技能 <50 时的大失败阈值（默认 96） */
  fumbleLowSkill: number;
  /** 技能 ≥50 时的大失败阈值（默认 100） */
  fumbleHighSkill: number;
  /** 按判定等级的理智损失表达式（默认房规，待 KP 确认；实际损失由引擎掷骰） */
  sanityLossTable: Record<SanityLevelKey, string>;
}

export const DEFAULT_COC7_HOUSE_RULES: Coc7HouseRules = {
  criticalMax: 1,
  fumbleLowSkill: 96,
  fumbleHighSkill: 100,
  sanityLossTable: {
    critical: '0',
    extreme: '0',
    hard: '1',
    normal: '1d2',
    fail: '1d6',
    fumble: '1d10',
  },
};

const SANITY_LEVEL_NAMES: Record<SanityLevelKey, string> = {
  critical: '大成功',
  extreme: '极难成功',
  hard: '困难成功',
  normal: '普通成功',
  fail: '失败',
  fumble: '大失败',
};

export class Coc7RuleBook implements RuleBook {
  readonly id = 'coc7' as const;

  private readonly rules: Coc7HouseRules;

  constructor(rules: Partial<Coc7HouseRules> = {}) {
    this.rules = { ...DEFAULT_COC7_HOUSE_RULES, ...rules };
    const { criticalMax } = this.rules;
    if (!Number.isInteger(criticalMax) || criticalMax < 1 || criticalMax > 5) {
      throw new RangeError('COC7 房规 criticalMax 须为 1–5 的整数');
    }
  }

  parseCheck(expr: string, ctx: RollContext = {}): ParsedCheck | null {
    const parsed = parseDiceExpr(expr);
    if (!parsed.check) return null;
    return {
      expr: parsed,
      check: {
        kind: ctx.kind ?? 'skill',
        target: parsed.check.target,
        difficulty: ctx.difficulty ?? 'normal',
      },
    };
  }

  adjudicate(roll: number, spec: CheckSpec): CheckResult {
    const { target } = spec;
    const fumbleThreshold = target < 50 ? this.rules.fumbleLowSkill : this.rules.fumbleHighSkill;

    if (roll <= this.rules.criticalMax) return { outcome: 'critical', grade: 'normal' };
    if (roll >= fumbleThreshold) return { outcome: 'fumble', grade: 'normal' };

    const natural = naturalGrade(roll, target);
    if (!natural) return { outcome: 'fail', grade: 'normal' };

    // KP 要求的难度档未达 → 失败（grade 保留已达成的自然档位）
    const demandedThreshold = difficultyThreshold(spec.difficulty, target);
    if (roll > demandedThreshold) return { outcome: 'fail', grade: natural };
    return { outcome: 'success', grade: natural };
  }

  sanityRule(roll: number, currentSan: number): SanityLoss {
    const result = this.adjudicate(roll, {
      kind: 'sanity',
      target: currentSan,
      difficulty: 'normal',
    });
    const key = sanityLevelKey(result.outcome, result.grade);
    const loss = this.rules.sanityLossTable[key];
    return { loss, desc: `${SANITY_LEVEL_NAMES[key]}：损失 ${loss}` };
  }

  adjudicateOpposed(a: OpposedSide, b: OpposedSide): OpposedResult {
    const rankA = successRank(
      this.adjudicate(a.roll, { kind: 'skill', target: a.skill, difficulty: 'normal' }),
    );
    const rankB = successRank(
      this.adjudicate(b.roll, { kind: 'skill', target: b.skill, difficulty: 'normal' }),
    );
    if (rankA === 0 && rankB === 0) return { winner: 'tie' }; // 双方均失败
    if (rankA !== rankB) return { winner: rankA > rankB ? 'a' : 'b' };
    if (a.skill !== b.skill) return { winner: a.skill > b.skill ? 'a' : 'b' }; // 同级比技能值
    return { winner: 'tie' };
  }
}

/** 自然成功档位：极难 ≤ target/5、困难 ≤ target/2、普通 ≤ target（向下取整） */
function naturalGrade(roll: number, target: number): 'extreme' | 'hard' | 'normal' | null {
  if (roll <= Math.floor(target / 5)) return 'extreme';
  if (roll <= Math.floor(target / 2)) return 'hard';
  if (roll <= target) return 'normal';
  return null;
}

function difficultyThreshold(difficulty: CheckSpec['difficulty'], target: number): number {
  switch (difficulty) {
    case 'extreme':
      return Math.floor(target / 5);
    case 'hard':
      return Math.floor(target / 2);
    case 'normal':
      return target;
  }
}

function sanityLevelKey(outcome: CheckResult['outcome'], grade: CheckGrade): SanityLevelKey {
  switch (outcome) {
    case 'critical':
      return 'critical';
    case 'fumble':
      return 'fumble';
    case 'fail':
      return 'fail';
    case 'success':
      return grade;
  }
}

/** 成功等级序：critical 4 > 极难 3 > 困难 2 > 普通 1 > 失败/大失败 0 */
function successRank(result: CheckResult): number {
  switch (result.outcome) {
    case 'critical':
      return 4;
    case 'fumble':
    case 'fail':
      return 0;
    case 'success':
      return result.grade === 'extreme' ? 3 : result.grade === 'hard' ? 2 : 1;
  }
}
