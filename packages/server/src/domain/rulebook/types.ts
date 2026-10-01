import type {
  CheckDifficulty,
  CheckGrade,
  CheckOp,
  CheckOutcome,
  DiceKind,
  Nat20Rule,
  RuleBookId,
} from '@behindveil/shared';
import type { ParsedDiceExpr } from '../dice/parser.js';

/**
 * 规则书端口（T-P-04，ADR-04 / TDD §5.3）。
 *
 * COC7 首发实现见 coc7.ts。接口形状经 DnD5e 设计推演
 * （00.development/notes/rulebook-5e-推演.md）：检定以 target+difficulty 承载；
 * sanityRule 为 COC7 专属可选能力；对抗检定为可选扩展点（TC-FR-04-008）。
 */

/** parseCheck 的判定请求：种类与难度由调用方（指令执行器 / 玩家骰网关）给出 */
export interface RollContext {
  kind?: DiceKind;
  difficulty?: CheckDifficulty;
}

/** TDD §5.3 parseCheck 产物：解析后的表达式 + 判定规格 */
export interface ParsedCheck {
  expr: ParsedDiceExpr;
  check: CheckSpec;
}

export interface CheckSpec {
  kind: DiceKind;
  /** 判定目标值（技能值 / SAN 值 / 幸运值 / 骰式后缀 target / 5e 的 DC 或 AC） */
  target: number;
  difficulty: CheckDifficulty;
  /**
   * 骰式判定后缀运算符（设计文档 v2 §5.2）。
   * 缺省按规则书默认语义：COC7 走 `<=` 判定表，5e 走 `>=` DC 比较。
   */
  op?: CheckOp;
}

/**
 * adjudicate 的判定输入（设计文档 v2 §5.2）。
 * - total：参与比较的数值（普通骰取 total，TC-FR-04-009）；
 * - raw：主骰原始面值（5e nat20/nat1 以面值判定，加修正后 25 不算 nat20）；
 *   无明确主骰（多骰组或未取舍的多颗骰）时为 null。
 */
export interface AdjudicateInput {
  total: number;
  raw: number | null;
}

/** 判定表产物：outcome 四分类 + grade 成功子等级（COC7 极难/困难是 success 的子等级） */
export interface CheckResult {
  outcome: CheckOutcome;
  grade: CheckGrade;
}

/**
 * 理智检定产物（TC-FR-04-015）：按成功等级给出损失表达式与描述。
 * 实际扣数由引擎对 loss 表达式掷骰并写状态板（T-M5-08）。
 */
export interface SanityLoss {
  /** 理智损失表达式（如 '1d6'），房规表可配 */
  loss: string;
  desc: string;
}

export interface OpposedSide {
  /** 该方 d100 原始骰值 */
  roll: number;
  skill: number;
}

export interface OpposedResult {
  winner: 'a' | 'b' | 'tie';
}

export interface RuleBook {
  readonly id: RuleBookId;
  /**
   * 未显式给出判定种类时的默认种类（玩家手掷骰走这条）。
   * COC7 = skill；5e = ability（FR-21：5e 手掷骰默认是属性检定，攻击/豁免由 AI 指令或后续显式指定）。
   */
  readonly defaultKind: DiceKind;
  /**
   * 影响判定结果的房规快照（复现用）：随 RollCheck 落审计流水，audit-replay 据此重算。
   * 当前仅 5e 的 nat20 适用面；COC7 房规恒默认（未接线到会话），故可选。
   */
  readonly nat20Rule?: Nat20Rule;
  /** 从骰式解析判定规格（TDD §5.3）；表达式无判定后缀时返回 null */
  parseCheck(expr: string, ctx: RollContext): ParsedCheck | null;
  /** 判定表（TDD §5.3）：按 total 比对目标值；raw 供 nat20/nat1 类面值规则使用 */
  adjudicate(roll: AdjudicateInput, spec: CheckSpec): CheckResult;
  /** COC7 理智规则（可选能力） */
  sanityRule?(roll: number, currentSan: number): SanityLoss;
  /** 对抗检定（可选能力，TC-FR-04-008：按成功等级与技能值裁定胜/负/平） */
  adjudicateOpposed?(a: OpposedSide, b: OpposedSide): OpposedResult;
}
