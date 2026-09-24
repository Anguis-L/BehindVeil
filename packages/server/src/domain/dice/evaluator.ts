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
    const rulebook = opts.rulebook;
    if (!rulebook) {
      throw new DiceExpressionError('表达式带判定后缀但未提供规则书');
    }
    const kind = opts.kind ?? 'skill';
    const difficulty = opts.difficulty ?? 'normal';
    const outcome = rulebook.adjudicate(data.total, {
      kind,
      target: parsed.check.target,
      difficulty,
    });
    check = {
      rulebook: rulebook.id,
      kind,
      target: parsed.check.target,
      difficulty,
      outcome: outcome.outcome,
      grade: outcome.grade,
    };
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
