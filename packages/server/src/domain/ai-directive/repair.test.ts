import { describe, expect, it } from 'vitest';
import { repairJson } from './repair.js';

/**
 * T-M3-01：JSON 容错修复（TDD §5.4「去注释/尾逗号修复」）。
 * 对应 TC-FR-05-002。修复为尽力而为：不可修复输入原样返回，交给 JSON.parse 报错。
 */

/** 修复后必须能被 JSON.parse 接受且语义等于期望对象 */
function expectRepairsTo(src: string, expected: unknown): void {
  expect(JSON.parse(repairJson(src))).toEqual(expected);
}

describe('尾逗号修复（TC-FR-05-002）', () => {
  it.each([
    ['{"op":"check",}', { op: 'check' }],
    ['{"a":[1,2,]}', { a: [1, 2] }],
    ['{"a":[1,2,],}', { a: [1, 2] }],
    ['{"op":"check",\n}', { op: 'check' }], // 逗号后跨行
    ['[1, 2, 3  ,  ]', [1, 2, 3]],
  ])('repairJson(%j) 可解析', (src, expected) => {
    expectRepairsTo(src, expected);
  });

  it('字符串内的逗号+右括号序列不受尾逗号修复误伤', () => {
    expectRepairsTo('{"label": "翻查, }书桌", "op": "check"}', {
      label: '翻查, }书桌',
      op: 'check',
    });
  });
});

describe('注释剥离（TC-FR-05-002）', () => {
  it.each([
    ['{\n// 这是说明\n"op": "check"\n}', { op: 'check' }],
    ['{"op": "check" /* 行内说明 */}', { op: 'check' }],
    ['{"op": "check"} // 行尾说明', { op: 'check' }],
    ['{ /* 多行\n   注释 */ "op": "check" }', { op: 'check' }],
  ])('repairJson(%j) 可解析', (src, expected) => {
    expectRepairsTo(src, expected);
  });

  it('字符串内的 // 与 /* 不被当作注释', () => {
    expectRepairsTo('{"a": "http://x", "b": "路径/*-copy"}', {
      a: 'http://x',
      b: '路径/*-copy',
    });
  });

  it('转义引号内的注释符号不终止字符串', () => {
    expectRepairsTo('{"a": "他说 \\"// 别信\\"", "op": "check"}', {
      a: '他说 "// 别信"',
      op: 'check',
    });
  });

  it('未闭合块注释吞到末尾（尽力而为）', () => {
    expect(JSON.parse(repairJson('{"op": "check"} /* 尾部说明未闭合'))).toEqual({ op: 'check' });
  });
});

describe('组合与边界（TC-FR-05-002）', () => {
  it('尾逗号 + 注释 + 多余空白一次修复', () => {
    expectRepairsTo(
      [
        '{',
        '  // 检定指令',
        '  "op": "check",',
        '  "target": "pc:alice", /* 目标 */',
        '  "skill": "侦查",',
        '}',
      ].join('\n'),
      { op: 'check', target: 'pc:alice', skill: '侦查' },
    );
  });

  it('合法 JSON 原样通过（幂等）', () => {
    const src = '{"op":"check","skill":"侦查"}';
    expect(repairJson(src)).toBe(src);
  });

  it('未闭合字符串原样返回（修复不猜内容）', () => {
    const src = '{"op": "che';
    expect(repairJson(src)).toBe(src);
  });

  it('孤立斜杠按普通字符处理', () => {
    expectRepairsTo('{"a": "1/2", "op": "check"}', { a: '1/2', op: 'check' });
  });
});
