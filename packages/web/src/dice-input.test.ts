import { describe, expect, it } from 'vitest';
import { parseDiceInput } from './dice-input.js';

/**
 * T-M4-05：`.r` 输入解析（纯函数，不触网）。
 * 前端只识别意图；骰式是否合法由服务端 E-DICE-01 判定。
 */

describe('.r 骰式输入（FR-06）', () => {
  it('.r 1d100<=60 → 明骰', () => {
    expect(parseDiceInput('.r 1d100<=60')).toEqual({
      kind: 'dice',
      expr: '1d100<=60',
      hidden: false,
    });
  });

  it('.rh 1d100 → 暗骰（仅自己与 KP 可见，D-10）', () => {
    expect(parseDiceInput('.rh 1d100')).toEqual({ kind: 'dice', expr: '1d100', hidden: true });
  });

  it('.r 不带骰式时按惯例补 1d100', () => {
    expect(parseDiceInput('.r')).toEqual({ kind: 'dice', expr: '1d100', hidden: false });
    expect(parseDiceInput('.rh ')).toEqual({ kind: 'dice', expr: '1d100', hidden: true });
  });

  it('骰式原样上送（合法性交给服务端，前端不猜）', () => {
    expect(parseDiceInput('.r 4d6kh3+2')).toEqual({
      kind: 'dice',
      expr: '4d6kh3+2',
      hidden: false,
    });
  });
});

describe('非骰式输入原样为发言', () => {
  it('普通文本不被误判', () => {
    expect(parseDiceInput('我推开石门')).toEqual({ kind: 'message', content: '我推开石门' });
  });

  it('句中出现的 .r 不算指令（只认整行以 .r 开头）', () => {
    const input = '他说 .r 1d100 是暗号';
    expect(parseDiceInput(input)).toEqual({ kind: 'message', content: input });
  });

  it('.rd 之类的未知前缀不是指令', () => {
    expect(parseDiceInput('.rd 1d100').kind).toBe('message');
  });
});
