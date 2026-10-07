import { type GenericGrade, type GenericRule, type DiceKind } from '@behindveil/shared';
import { DiceExpressionError, parseDiceExpr } from '../dice/parser.js';
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
 * generic 规则书（v3 FR-40 / ADR-3-08，设计文档 v3 §5.5）。
 *
 * 配置驱动的通用判定表：骰型、比较方向、判定种类、成功档表、对抗平局口径全部来自
 * KP 卡 `extensions.aidle.genericRule`，不绑定任何具体商业规则。判定语义：
 * - 档表（可选）按序首个命中生效，改判 outcome（`raw`/`total` 面值规则即 nat 开关的配置化）；
 * - 未命中档表时按 op 比对 total，布尔判定 success/fail（与 5e 的 DC 形态同构）；
 * - 对抗比 total，高者胜，平局按 opposedTie 三口径裁定；
 * - 无理智规则（sanityRule 恒 false，不实现该可选能力）。
 *
 * `when` 文法刻意保持受限（只比 raw/total，设计 §7.5 红线）：手写递归下降解析，
 * 装载时编译为谓词闭包，严禁 eval / 第三方表达式库——许可证与安全双重红线。
 */

/** when 谓词的求值上下文：raw 为主骰面值（无明确主骰时为 null，raw 类条件不命中） */
export interface WhenContext {
  raw: number | null;
  total: number;
}

type WhenPredicate = (ctx: WhenContext) => boolean;

/**
 * 编译 when 表达式（装载时一次）。
 * 文法：`or := and ("||" and)*`；`and := cmp ("&&" cmp)*`；
 * `cmp := ("raw"|"total") ("<="|">="|"<"|">"|"="|"==") 数`。
 * 任何文法外输入一律 RangeError—— KP 卡装载时即拒（E-MOD-01），不带病进会话。
 */
export function compileWhen(source: string): WhenPredicate {
  let pos = 0;
  const input = source;

  function fail(reason: string): never {
    throw new RangeError(`generic 档表 when 文法错误（${reason}）：${source}`);
  }
  function skipSpaces(): void {
    while (pos < input.length && /\s/.test(input[pos] as string)) pos += 1;
  }
  function eat(literal: string): boolean {
    skipSpaces();
    if (input.startsWith(literal, pos)) {
      pos += literal.length;
      return true;
    }
    return false;
  }

  function parseCmp(): WhenPredicate {
    skipSpaces();
    const idMatch = /^(raw|total)/.exec(input.slice(pos));
    if (!idMatch) fail('须以 raw 或 total 开头');
    const operand = idMatch[1] as 'raw' | 'total';
    pos += operand.length;
    skipSpaces();
    const op = ['<=', '>=', '==', '<', '>', '='].find((candidate) =>
      input.startsWith(candidate, pos),
    );
    if (!op) fail('缺比较符（<= >= < > =）');
    pos += op.length;
    skipSpaces();
    const numMatch = /^-?\d+(?:\.\d+)?/.exec(input.slice(pos));
    if (!numMatch) fail('缺数字');
    const value = Number(numMatch[0]);
    pos += numMatch[0].length;
    if (!Number.isFinite(value)) fail('数字非法');
    return (ctx) => {
      const left = ctx[operand];
      // raw 为 null（多骰组/未取舍）时面值条件不成立——主骰语义不存在即不命中
      if (left === null) return false;
      switch (op) {
        case '<=':
          return left <= value;
        case '>=':
          return left >= value;
        case '<':
          return left < value;
        case '>':
          return left > value;
        default:
          return left === value; // '=' 与 '==' 同义
      }
    };
  }

  function parseAnd(): WhenPredicate {
    const parts = [parseCmp()];
    while (eat('&&')) parts.push(parseCmp());
    if (parts.length === 1) return parts[0] as WhenPredicate;
    return (ctx) => parts.every((test) => test(ctx));
  }

  function parseOr(): WhenPredicate {
    const parts = [parseAnd()];
    while (eat('||')) parts.push(parseAnd());
    if (parts.length === 1) return parts[0] as WhenPredicate;
    return (ctx) => parts.some((test) => test(ctx));
  }

  const predicate = parseOr();
  skipSpaces();
  if (pos !== input.length) fail(`位置 ${pos} 处有无法解析的残余`);
  return predicate;
}

/**
 * generic 规则书实例。构造即编译（骰式可解析、when 文法校验），坏配置构造即抛——
 * 调用方（工厂/开团装载）据此把配置错误挡在会话开始之前。
 */
export class GenericRuleBook implements RuleBook {
  readonly id = 'generic' as const;
  readonly defaultKind: DiceKind;
  /** 判定配置快照（执行器拼骰式、evaluator 落审计快照用） */
  readonly genericConfig: GenericRule;

  private readonly compiled: Array<{ name: GenericGrade['name']; test: WhenPredicate }>;

  constructor(config: GenericRule) {
    this.genericConfig = config;
    try {
      const parsed = parseDiceExpr(config.dice);
      if (parsed.check) {
        throw new RangeError(`generic 主骰式不带判定后缀（目标值来自检定请求）：${config.dice}`);
      }
    } catch (err) {
      if (err instanceof RangeError) throw err;
      const detail = err instanceof DiceExpressionError ? err.message : String(err);
      throw new RangeError(`generic 主骰式不是合法骰式：${config.dice}（${detail}）`);
    }
    this.defaultKind = config.kinds[0] ?? 'check';
    this.compiled = (config.grades ?? []).map((grade) => ({
      name: grade.name,
      test: compileWhen(grade.when),
    }));
  }

  /** 判定后缀随骰式解析（op 透传落审计流水）；无后缀 = 纯骰值（如对抗/先攻掷）返回 null */
  parseCheck(expr: string, ctx: RollContext = {}): ParsedCheck | null {
    const parsed = parseDiceExpr(expr);
    if (!parsed.check) return null;
    return {
      expr: parsed,
      check: {
        kind: ctx.kind ?? this.defaultKind,
        target: parsed.check.target,
        difficulty: ctx.difficulty ?? 'normal',
        op: parsed.check.op,
      },
    };
  }

  adjudicate(roll: AdjudicateInput, spec: CheckSpec): CheckResult {
    // 档表按序首个命中生效（设计 §5.5）——nat 面值规则与多档结果的统一载体
    for (const grade of this.compiled) {
      if (grade.test({ raw: roll.raw, total: roll.total })) {
        return { outcome: grade.name, grade: 'normal' };
      }
    }
    const op = spec.op ?? this.genericConfig.op;
    const passed =
      op === '<='
        ? roll.total <= spec.target
        : op === '='
          ? roll.total === spec.target
          : roll.total >= spec.target;
    return { outcome: passed ? 'success' : 'fail', grade: 'normal' };
  }

  /** 对抗比 total（与 5e 同构：OpposedSide.roll 传该方 total），平局按配置口径 */
  adjudicateOpposed(a: OpposedSide, b: OpposedSide): OpposedResult {
    if (a.roll === b.roll) {
      switch (this.genericConfig.opposedTie) {
        case 'attacker':
          return { winner: 'a' };
        case 'defender':
          return { winner: 'b' };
        default:
          return { winner: 'tie' };
      }
    }
    return { winner: a.roll > b.roll ? 'a' : 'b' };
  }
}

/**
 * 装载编译缓存（ADR-3-08）：同一配置只编译一次，判定热路径与 coc7/dnd5e 同构零新增开销。
 * 配置来源是 KP 卡（模组数级别），缓存无淘汰亦不会增长失控。
 */
const compileCache = new Map<string, GenericRuleBook>();

/** 配置的稳定序列化键（键序无关，程序化构造与 JSON 解析的同内容配置命中同一缓存项） */
function stableKey(config: GenericRule): string {
  return JSON.stringify(config, (_key, value: unknown) =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : value,
  );
}

export function createGenericRuleBook(config: GenericRule): GenericRuleBook {
  const key = stableKey(config);
  let book = compileCache.get(key);
  if (!book) {
    book = new GenericRuleBook(config);
    compileCache.set(key, book);
  }
  return book;
}

/** 对抗平局口径的速查文案（S1 规则书速查用） */
const OPPOSED_TIE_LABELS = {
  attacker: '平局进攻方胜',
  defender: '平局防守方胜',
  tie: '平局僵持',
} as const;

/**
 * generic 的 S1 规则速查（stages.ts 消费）：coc7/5e 的速查是固定文案，
 * generic 的判定语义来自配置，速查随之生成——AI 需要知道骰型/档表与「必须带 dc」。
 */
export function genericQuickRef(config: GenericRule): string {
  const parts = [
    `检定速查（generic：KP 自定义判定表）：掷 ${config.dice}，结果${config.op}目标值则成功。`,
    `判定种类：${config.kinds.join(' / ')}。`,
  ];
  if (config.grades?.length) {
    parts.push(
      `档表（按序首个命中即改判）：${config.grades.map((g) => `${g.when} → ${g.name}`).join('；')}。`,
    );
  }
  parts.push(`${OPPOSED_TIE_LABELS[config.opposedTie]}。`);
  parts.push('检定指令必须带 dc（目标值，主持难度）。');
  return parts.join('');
}
