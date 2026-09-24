import { describe, expect, it } from 'vitest';
import {
  DICE_HELP_TEXT,
  DiceExpressionError,
  MAX_DICE_COUNT,
  MAX_EXPR_LENGTH,
  MAX_SIDES,
  parseDiceExpr,
} from './parser.js';

/**
 * T-P-01：骰式词法 + 递归下降 parser（TDD §5.3 BNF）。
 * 对应 TC-FR-04-001~006、009 的解析侧；判定语义在 rulebook/coc7.test.ts。
 * 实现口径：TDD BNF 的 term 行按标准中缀四则实现（括号 v1 不支持，文法未定义）。
 */

describe('规范化表达式（RollResult.expr）', () => {
  it.each([
    ['1d100', '1d100'],
    ['1D100', '1d100'], // 大小写不敏感
    ['d6', '1d6'], // 省略骰数补 1
    [' 2d6 + 3 ', '2d6+3'], // 去空白
    ['4dF', '4dF'], // 命运骰保留 F
    ['4df', '4dF'],
    ['3d6kh2', '3d6kh2'],
    ['3d6+2d10-1*2', '3d6+2d10-1*2'],
    ['1d100<=50', '1d100<=50'],
  ])('parse(%j).canonical === %j', (input, canonical) => {
    expect(parseDiceExpr(input).canonical).toBe(canonical);
  });

  it('保留原始输入（审计留痕需要）', () => {
    expect(parseDiceExpr(' 1D100 ').raw).toBe('1D100');
  });
});

describe('AST 结构', () => {
  it('数字因子', () => {
    expect(parseDiceExpr('7').root).toEqual({ kind: 'number', value: 7 });
  });

  it('骰组带修改器', () => {
    expect(parseDiceExpr('4d6kh3').root).toEqual({
      kind: 'dice',
      count: 4,
      sides: 6,
      modifier: { kind: 'kh', count: 3 },
    });
  });

  it('命运骰 sides 为 F', () => {
    expect(parseDiceExpr('4dF').root).toEqual({
      kind: 'dice',
      count: 4,
      sides: 'F',
      modifier: null,
    });
  });

  it('四则按中缀优先级结合（乘除紧于加减）', () => {
    const root = parseDiceExpr('3d6+2d10-1*2').root;

    expect(root).toMatchObject({ kind: 'binary', op: '-' });
    expect(root.kind === 'binary' && root.left).toMatchObject({ kind: 'binary', op: '+' });
    expect(root.kind === 'binary' && root.right).toMatchObject({ kind: 'binary', op: '*' });
  });

  it('括号 v1 不支持（文法未定义）', () => {
    expect(() => parseDiceExpr('(1d6+2)*3')).toThrow(DiceExpressionError);
  });
});

describe('判定后缀（TC-FR-04-005）', () => {
  it.each([
    ['1d100<=50', { op: '<=' as const, target: 50 }],
    ['1d100>=50', { op: '>=' as const, target: 50 }],
    ['1d100=50', { op: '=' as const, target: 50 }],
    ['2d6+3<=8', { op: '<=' as const, target: 8 }],
  ])('%s 解析出判定规格', (input, expected) => {
    expect(parseDiceExpr(input).check).toEqual(expected);
  });

  it('无判定后缀时 check 为 null', () => {
    expect(parseDiceExpr('1d100').check).toBeNull();
  });
});

describe('非法表达式全分支（TC-FR-04-006，E-DICE-01）', () => {
  const illegal: Array<[string, string]> = [
    ['', '空'],
    ['   ', '仅空白'],
    ['abc', '未知记号（字母）'],
    ['1d100 + @', '未知记号（符号）'],
    ['0d6', '0 骰'],
    ['1d0', '0 面'],
    ['1d', '缺面数'],
    ['1dX', '非法面数'],
    ['F', 'F 不能单独使用'],
    ['1d6+', '表达式不完整'],
    ['1d6kh', '修改器缺数量'],
    ['1d6kh0', '修改器数量非正'],
    ['1d6 7', '末尾多余内容'],
    ['1d100<', '判定后缀不完整'],
    ['1d100<=x', '判定后缀非数字'],
    ['-1d6', '前置负号（v1 无一元负号）'],
    [`${'1d6+'.repeat(100)}1`, `超长（>${MAX_EXPR_LENGTH}）`],
    [`${MAX_DICE_COUNT + 1}d6`, `骰数超上限（>${MAX_DICE_COUNT}）`],
    [`1d${MAX_SIDES + 1}`, `面数超上限（>${MAX_SIDES}）`],
  ];

  it.each(illegal)('%s 被拒绝（%s）', (input) => {
    expect(() => parseDiceExpr(input)).toThrow(DiceExpressionError);
  });

  it('错误带 E-DICE-01 与帮助文本（行内提示不刷屏）', () => {
    let caught: unknown;
    try {
      parseDiceExpr('0d6');
    } catch (cause) {
      caught = cause;
    }

    expect(caught).toBeInstanceOf(DiceExpressionError);
    expect(caught).toMatchObject({ code: 'E-DICE-01' });
    expect((caught as DiceExpressionError).help).toBe(DICE_HELP_TEXT);
    expect(DICE_HELP_TEXT.length).toBeGreaterThan(0);
  });
});
