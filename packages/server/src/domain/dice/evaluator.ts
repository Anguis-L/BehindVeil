import type { CheckDifficulty, DiceKind, RollCheck } from '@behindveil/shared';
import { DiceExpressionError, parseDiceExpr, type DiceModifier, type DiceNode } from './parser.js';
import type { RandomSource } from './random.js';
import type { RuleBook } from '../rulebook/types.js';

/**
 * 骰式求值器（T-P-02，TDD §5.3）。
 *
 * 求值约定（审计重算须与此一致，D-04）：
 * - rolls：每个骰组的原始骰值，按表达式求值顺序排列；dF 值域 {-1, 0, +1}；
 * - kept：应用 kh/kl/dh/dl 后的保留值（修改器数量超过骰数时全部保留），按骰组平铺；
 * - 除法向零取整（Math.trunc）：骰域为整数，保证 total 恒为整数且可复现；
 * - 判定后缀按 total 与 target 比对（TC-FR-04-009：2d6+3<=8 的判定对象是四则 total）；
 *   提供规则书时产出 RollCheck（v1 仅 COC7）。
 * - 判定运算符（2026-09-25 拍板方案 a，T-M4-02 落地）：`<=` 走规则书判定表（六档）；
 *   `>=` / `=` 走通用布尔比较，outcome 仅 success/fail、不带 grade（如 5e 的 1d20+5>=13）。
 */
export interface RollData {
  rolls: number[][];
  kept: number[];
  total: number;
}

export function evaluate(node: DiceNode, random: RandomSource): RollData {
  switch (node.kind) {
    case 'number':
      return { rolls: [], kept: [], total: node.value };
    case 'dice':
      return evaluateDice(node, random);
    case 'binary': {
      const left = evaluate(node.left, random);
      const right = evaluate(node.right, random);
      return {
        rolls: [...left.rolls, ...right.rolls],
        kept: [...left.kept, ...right.kept],
        total: applyOp(node.op, left.total, right.total),
      };
    }
  }
}

function evaluateDice(node: Extract<DiceNode, { kind: 'dice' }>, random: RandomSource): RollData {
  const rolls: number[] = [];
  for (let i = 0; i < node.count; i += 1) {
    rolls.push(node.sides === 'F' ? random.int(-1, 1) : random.int(1, node.sides));
  }
  const kept = applyModifier(rolls, node.modifier);
  return { rolls: [rolls], kept, total: kept.reduce((sum, v) => sum + v, 0) };
}

function applyModifier(rolls: number[], modifier: DiceModifier | null): number[] {
  if (!modifier) return [...rolls];
  const ascending = [...rolls].sort((a, b) => a - b);
  const descending = [...rolls].sort((a, b) => b - a);
  const n = Math.min(modifier.count, rolls.length);
  switch (modifier.kind) {
    case 'kh':
      return descending.slice(0, n);
    case 'kl':
      return ascending.slice(0, n);
    case 'dh':
      return descending.slice(n);
    case 'dl':
      return ascending.slice(n);
  }
}

function applyOp(op: '+' | '-' | '*' | '/', left: number, right: number): number {
  switch (op) {
    case '+':
      return left + right;
    case '-':
      return left - right;
    case '*':
      return left * right;
    case '/':
      if (right === 0) throw new DiceExpressionError('除数为零');
      return Math.trunc(left / right);
  }
}

export interface RollOptions {
  random: RandomSource;
  /** 提供时对判定后缀做规则书判定（TC-FR-04-005：`1d100<=50` → check） */
  rulebook?: RuleBook;
  /** 判定种类（默认 skill） */
  kind?: DiceKind;
  /** KP 要求的难度档（默认 normal） */
  difficulty?: CheckDifficulty;
}

export interface ParsedRoll {
  /** 规范化表达式（RollResult.expr） */
  expr: string;
  /** 原始输入 */
  raw: string;
  rolls: number[][];
  kept: number[];
  total: number;
  /**
   * 表达式带判定后缀且提供规则书时产出；audit 字段由 T-M4-01 审计流水落账时补充，
   * 本引擎不自行产生审计号（审计写路径集中在 audit.ts）。
   */
  check: RollCheck | null;
}

/** 一站式掷骰：解析 → 静态校验 → 求值 →（可选）规则书判定 */
export function rollDice(rawExpr: string, opts: RollOptions): ParsedRoll {
  const parsed = parseDiceExpr(rawExpr);
  assertNoStaticDivideByZero(parsed.root);
  const data = evaluate(parsed.root, opts.random);

  let check: RollCheck | null = null;
  if (parsed.check) {
    // 判定权威必须明确：任何判定后缀（含 >=/=）都要求装配规则书（v1 恒为 COC7）
    const rulebook = opts.rulebook;
    if (!rulebook) {
      throw new DiceExpressionError('表达式带判定后缀但未提供规则书');
    }
    const kind = opts.kind ?? 'skill';
    const difficulty = opts.difficulty ?? 'normal';
    const { op, target } = parsed.check;
    if (op === '<=') {
      const outcome = rulebook.adjudicate(data.total, { kind, target, difficulty });
      check = {
        rulebook: rulebook.id,
        kind,
        target,
        difficulty,
        op,
        outcome: outcome.outcome,
        grade: outcome.grade,
      };
    } else {
      // 通用布尔判定：不查规则书判定表，故无 grade
      const passed = op === '>=' ? data.total >= target : data.total === target;
      check = {
        rulebook: rulebook.id,
        kind,
        target,
        difficulty,
        op,
        outcome: passed ? 'success' : 'fail',
      };
    }
  }

  return {
    expr: parsed.canonical,
    raw: parsed.raw,
    rolls: data.rolls,
    kept: data.kept,
    total: data.total,
    check,
  };
}

/**
 * 审计复现（T-M4-04，决议 D-04）：以流水里的原始骰值重放求值，**不消耗随机源**。
 * CSPRNG 无种子、不可重放，故「复现」= 相同 expr + 相同 rolls 必然算出相同的
 * kept/total/check——校验的是求值与判定的正确性，不是重新生成随机数。
 * 骰值数量与表达式所需不符即抛错（防「拿别的骰值凑出一样的结果」蒙混过关）。
 */
export function replayRoll(
  expr: string,
  rolls: number[][],
  opts: Pick<RollOptions, 'rulebook' | 'kind' | 'difficulty'> = {},
): ParsedRoll {
  const source = replaySource(rolls);
  const roll = rollDice(expr, { ...opts, random: source });
  const provided = rolls.reduce((sum, group) => sum + group.length, 0);
  if (source.consumed !== provided) {
    throw new DiceExpressionError(
      `审计复现失败：表达式 ${expr} 需要 ${source.consumed} 个骰值，流水给了 ${provided} 个`,
    );
  }
  return roll;
}

/** 按组顺序吐出预置骰值的伪随机源：只用于复现，绝不产生新随机数 */
function replaySource(rolls: number[][]): RandomSource & { consumed: number } {
  let group = 0;
  let index = 0;
  let consumed = 0;
  return {
    get consumed(): number {
      return consumed;
    },
    int(min, max): number {
      const current = rolls[group];
      const value = current?.[index];
      if (current === undefined || value === undefined) {
        throw new DiceExpressionError('审计复现失败：原始骰值不足以重放该表达式');
      }
      // 值域校验（TDD §5.3）：流水里的骰值必须落在本骰的 [min, max] 内，
      // 否则「拿别的骰值凑 total」的伪造流水也能蒙混过关
      if (!Number.isInteger(value) || value < min || value > max) {
        throw new DiceExpressionError(
          `审计复现失败：骰值 ${value} 超出 ${min}–${max} 值域，流水可能被篡改`,
        );
      }
      consumed += 1;
      index += 1;
      if (index >= current.length) {
        group += 1;
        index = 0;
      }
      return value;
    },
  };
}

/** 解析期即可发现的除零（右操作数为字面量 0）：保证「不掷骰」，避免先消耗随机数（TC-FR-04-006） */
function assertNoStaticDivideByZero(node: DiceNode): void {
  switch (node.kind) {
    case 'binary':
      assertNoStaticDivideByZero(node.left);
      assertNoStaticDivideByZero(node.right);
      if (node.op === '/' && node.right.kind === 'number' && node.right.value === 0) {
        throw new DiceExpressionError('除数为零');
      }
      return;
    default:
      return;
  }
}
