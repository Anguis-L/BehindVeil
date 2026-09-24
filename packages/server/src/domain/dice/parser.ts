/**
 * 骰式解析器（T-P-01，TDD §5.3 BNF；手写递归下降，不引第三方库——判定语义必须自己掌控）。
 *
 * 文法（TDD §5.3）：
 *   expr     := term (("+"|"-") term)*
 *   term     := factor (("*"|"/") factor)*
 *   factor   := number | dice
 *   dice     := count? "d" (number | "F") modifier?
 *   modifier := ("kh"|"kl"|"dh"|"dl") number
 *   check    := expr ("<=" | ">=" | "=") number
 *
 * 实现口径（与 TDD 原文的差异，待回写文档）：
 * - TDD BNF 的 term 行写作 `("*"|"/")? dice | number`，前缀乘除无语义；
 *   按标准中缀四则优先级实现（dice 绑定紧于乘除），如 3d6+2d10-1*2。
 * - 括号 v1 不支持（文法未定义）。
 *
 * 非法输入（未知记号/0 骰/负面数/超长等）一律抛 DiceExpressionError（E-DICE-01，
 * TC-FR-04-006），并附帮助文本；解析失败不产生任何掷骰。
 */
export const DICE_HELP_TEXT =
  '骰式语法：NdY（Y 为面数）或 NdF（命运骰），可带 kh/kl/dh/dl 修改器与 + - * / 四则运算，末尾可加判定后缀 <=N / >=N / =N。示例：1d100<=50、4d6kh3、3d6+2d10-1*2、4dF。';

/** 防失控上限：表达式长度（TC-FR-04-006「超长」分支） */
export const MAX_EXPR_LENGTH = 200;
/** 防失控上限：单个骰组的骰数 */
export const MAX_DICE_COUNT = 100;
/** 防失控上限：骰面数 */
export const MAX_SIDES = 1000;

export type DiceModifierKind = 'kh' | 'kl' | 'dh' | 'dl';

export interface DiceModifier {
  kind: DiceModifierKind;
  count: number;
}

export type DiceNode =
  | { kind: 'number'; value: number }
  | { kind: 'dice'; count: number; sides: number | 'F'; modifier: DiceModifier | null }
  | { kind: 'binary'; op: '+' | '-' | '*' | '/'; left: DiceNode; right: DiceNode };

export interface DiceCheckSuffix {
  op: '<=' | '>=' | '=';
  target: number;
}

export interface ParsedDiceExpr {
  /** 原始输入（trim 后） */
  raw: string;
  /** 规范化表达式（RollResult.expr）：小写化、补默认骰数、去空白 */
  canonical: string;
  root: DiceNode;
  check: DiceCheckSuffix | null;
}

/** 骰式非法（E-DICE-01）：行内提示 + 帮助文本（TDD §11） */
export class DiceExpressionError extends Error {
  readonly code = 'E-DICE-01';
  readonly help: string;

  constructor(message: string, help: string = DICE_HELP_TEXT) {
    super(message);
    this.name = 'DiceExpressionError';
    this.help = help;
  }
}

type Token =
  | { t: 'num'; value: number }
  | { t: 'd' }
  | { t: 'fate' }
  | { t: 'mod'; kind: DiceModifierKind }
  | { t: 'op'; op: '+' | '-' | '*' | '/' }
  | { t: 'check'; op: '<=' | '>=' | '=' };

export function parseDiceExpr(input: string): ParsedDiceExpr {
  const raw = input.trim();
  if (raw.length === 0) throw new DiceExpressionError('骰式为空');
  if (raw.length > MAX_EXPR_LENGTH) {
    throw new DiceExpressionError(`骰式超长（超过 ${MAX_EXPR_LENGTH} 字符）`);
  }
  return new Parser(tokenize(raw), raw).parse();
}

// ---- 词法 ----

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input.charAt(i);
    if (ch === ' ' || ch === '\t') {
      i += 1;
      continue;
    }
    if (isDigit(ch)) {
      let j = i;
      while (j < input.length && isDigit(input.charAt(j))) j += 1;
      tokens.push({ t: 'num', value: Number(input.slice(i, j)) });
      i = j;
      continue;
    }
    if (isAsciiLetter(ch)) {
      let j = i;
      while (j < input.length && isAsciiLetter(input.charAt(j))) j += 1;
      const word = input.slice(i, j).toLowerCase();
      i = j;
      switch (word) {
        case 'd':
          tokens.push({ t: 'd' });
          break;
        case 'f':
          tokens.push({ t: 'fate' });
          break;
        case 'df':
          tokens.push({ t: 'd' }, { t: 'fate' });
          break;
        case 'kh':
        case 'kl':
        case 'dh':
        case 'dl':
          tokens.push({ t: 'mod', kind: word });
          break;
        default:
          throw new DiceExpressionError(`无法识别的记号 "${word}"`);
      }
      continue;
    }
    switch (ch) {
      case '+':
      case '-':
      case '*':
      case '/':
        tokens.push({ t: 'op', op: ch });
        i += 1;
        break;
      case '<':
      case '>': {
        if (input.charAt(i + 1) === '=') {
          tokens.push(ch === '<' ? { t: 'check', op: '<=' } : { t: 'check', op: '>=' });
          i += 2;
        } else {
          throw new DiceExpressionError(`无法识别的记号 "${ch}"（判定后缀应为 <=、>= 或 =）`);
        }
        break;
      }
      case '=':
        tokens.push({ t: 'check', op: '=' });
        i += 1;
        break;
      default:
        throw new DiceExpressionError(`无法识别的记号 "${ch}"`);
    }
  }
  return tokens;
}

// ---- 语法（递归下降）----

class Parser {
  private pos = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly raw: string,
  ) {}

  parse(): ParsedDiceExpr {
    const root = this.parseExpr();
    let check: DiceCheckSuffix | null = null;
    const next = this.peek();
    if (next && next.t === 'check') {
      this.advance();
      const numTok = this.advance();
      if (!numTok || numTok.t !== 'num') {
        throw new DiceExpressionError('判定后缀应为数字，如 1d100<=50');
      }
      check = { op: next.op, target: numTok.value };
    }
    if (this.peek()) throw new DiceExpressionError('表达式末尾有多余内容');
    return { raw: this.raw, canonical: this.canonical(root, check), root, check };
  }

  private parseExpr(): DiceNode {
    let left = this.parseTerm();
    for (;;) {
      const next = this.peek();
      if (!next || next.t !== 'op' || (next.op !== '+' && next.op !== '-')) return left;
      this.advance();
      const right = this.parseTerm();
      left = { kind: 'binary', op: next.op, left, right };
    }
  }

  private parseTerm(): DiceNode {
    let left = this.parseFactor();
    for (;;) {
      const next = this.peek();
      if (!next || next.t !== 'op' || (next.op !== '*' && next.op !== '/')) return left;
      this.advance();
      const right = this.parseFactor();
      left = { kind: 'binary', op: next.op, left, right };
    }
  }

  private parseFactor(): DiceNode {
    const tok = this.advance();
    if (!tok) throw new DiceExpressionError('表达式不完整');
    if (tok.t === 'num') {
      const next = this.peek();
      if (next && next.t === 'd') {
        this.advance();
        return this.parseDice(tok.value);
      }
      return { kind: 'number', value: tok.value };
    }
    if (tok.t === 'd') return this.parseDice(1);
    if (tok.t === 'fate') throw new DiceExpressionError('"F" 只能作为骰面（如 4dF）');
    throw new DiceExpressionError('此处应为数字或骰式');
  }

  private parseDice(count: number): DiceNode {
    if (count < 1) throw new DiceExpressionError('骰数必须为正整数');
    if (count > MAX_DICE_COUNT) throw new DiceExpressionError(`骰数超出上限（${MAX_DICE_COUNT}）`);

    const sidesTok = this.advance();
    if (!sidesTok) throw new DiceExpressionError('"d" 后应为面数或 F');
    let sides: number | 'F';
    if (sidesTok.t === 'fate') {
      sides = 'F';
    } else if (sidesTok.t === 'num') {
      if (sidesTok.value < 1) throw new DiceExpressionError('骰面数必须为正');
      if (sidesTok.value > MAX_SIDES)
        throw new DiceExpressionError(`骰面数超出上限（${MAX_SIDES}）`);
      sides = sidesTok.value;
    } else {
      throw new DiceExpressionError('"d" 后应为面数或 F');
    }

    let modifier: DiceModifier | null = null;
    const modTok = this.peek();
    if (modTok && modTok.t === 'mod') {
      this.advance();
      const nTok = this.advance();
      if (!nTok || nTok.t !== 'num') {
        throw new DiceExpressionError(`${modTok.kind} 后应为保留/弃置数量`);
      }
      if (nTok.value < 1) throw new DiceExpressionError('修改器数量必须为正整数');
      modifier = { kind: modTok.kind, count: nTok.value };
    }

    return { kind: 'dice', count, sides, modifier };
  }

  private canonical(root: DiceNode, check: DiceCheckSuffix | null): string {
    // 文法无括号且二元节点两侧因子优先级固定，可直接序列化回规范式
    let text = serialize(root);
    if (check) text += `${check.op}${check.target}`;
    return text;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private advance(): Token | undefined {
    const tok = this.tokens[this.pos];
    this.pos += 1;
    return tok;
  }
}

function serialize(node: DiceNode): string {
  switch (node.kind) {
    case 'number':
      return String(node.value);
    case 'dice': {
      const sides = node.sides === 'F' ? 'F' : String(node.sides);
      const modifier = node.modifier ? `${node.modifier.kind}${node.modifier.count}` : '';
      return `${node.count}d${sides}${modifier}`;
    }
    case 'binary':
      return `${serialize(node.left)}${node.op}${serialize(node.right)}`;
  }
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isAsciiLetter(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}
