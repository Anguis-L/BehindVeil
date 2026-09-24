import { describe, expect, it } from 'vitest';
import { createHeuristicTokenizer } from './tokenizer.js';

/**
 * T-M0-06：启发式 tokenizer（决议 D-06）。
 * 规则：CJK ≈ 1 字 / token，ASCII ≈ 4 字符 / token；接口注入，后续可换精确实现。
 * 断言重点：不得系统性低估（低估会导致 S4 预算失守，见 TC-FR-07-017）。
 */

const tok = createHeuristicTokenizer();

const cjkCount = (text: string): number => (text.match(/[㐀-鿿぀-ヿ]/gu) ?? []).length;
const lowerBound = (text: string): number => {
  const cjk = cjkCount(text);
  const rest = text.replace(/\s/gu, '').length - cjk;
  return cjk + Math.ceil(rest / 4);
};

describe('启发式估算基线', () => {
  it('空串为 0', () => {
    expect(tok.count('')).toBe(0);
  });

  it('ASCII 约 4 字符 1 token', () => {
    expect(tok.count('a'.repeat(4))).toBe(1);
    expect(tok.count('a'.repeat(8))).toBe(2);
    expect(tok.count('a'.repeat(400))).toBe(100);
  });

  it('不足 4 字符的部分向上取整（宁可高估）', () => {
    expect(tok.count('a'.repeat(5))).toBe(2);
    expect(tok.count('a'.repeat(7))).toBe(2);
  });

  it('CJK 约 1 字 1 token', () => {
    expect(tok.count('你')).toBe(1);
    expect(tok.count('你好世界')).toBe(4);
    expect(tok.count('守秘人'.repeat(100))).toBe(300);
  });

  it('数字与标点按 ASCII 规则计', () => {
    expect(tok.count('12345678')).toBe(2);
  });
});

describe('无系统性低估（预算安全，TC-FR-07-017 的 M0 版）', () => {
  const samples = [
    '你推开书房的门，空气中浮着灰尘。',
    'The Keeper smiles. 守秘人微笑着。',
    '1d100<=50 侦查 60',
    '```aidle\n{"op":"check","skill":"侦查"}\n```',
    'a',
    '中文 with mixed 1234567890 content！',
  ];

  it.each(samples)('估算值不低于字符数下界：%s', (text) => {
    expect(tok.count(text)).toBeGreaterThanOrEqual(lowerBound(text));
  });

  it.each(samples)('估算值不超过字符总数：%s', (text) => {
    expect(tok.count(text)).toBeLessThanOrEqual(text.length);
  });

  it('随文本增长单调不减', () => {
    const text = '玩家推开书房的门，The Keeper watches silently. 1234567890';
    let previous = 0;
    for (let i = 1; i <= text.length; i += 1) {
      const current = tok.count(text.slice(0, i));
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });
});
