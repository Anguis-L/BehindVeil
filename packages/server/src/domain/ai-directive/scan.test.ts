import { describe, expect, it } from 'vitest';
import { DirectiveStreamScanner, type DirectiveScanEvent } from './scan.js';

/**
 * T-M3-01：AI 指令块流式扫描器（TDD §5.4 处理循环）。
 * 对应 TC-FR-05-003（截断流）、TC-FR-05-004（连续多块），并复验
 * TC-FR-05-001/002 在真实流式路径上的表现（含跨 delta 切分）。
 */

const CHECK_JSON =
  '{"op": "check", "target": "pc:alice", "skill": "侦查", "difficulty": "normal", "label": "翻查书桌"}';

const fence = (json: string): string => `\`\`\`aidle\n${json}\n\`\`\``;

/** 整流喂入（可指定 chunk 大小模拟流式切分）+ flush，返回全部事件 */
function scanAll(text: string, chunkSize = Infinity): DirectiveScanEvent[] {
  const scanner = new DirectiveStreamScanner();
  const events: DirectiveScanEvent[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    events.push(...scanner.feed(text.slice(i, i + chunkSize)));
  }
  events.push(...scanner.flush());
  return events;
}

describe('单一指令块（TC-FR-05-001 流式路径）', () => {
  it('叙事文本中的指令块解析为 directive 事件，区间切片还原栅栏原文', () => {
    const stream = `前文叙事。\n${fence(CHECK_JSON)}\n后文叙事。`;
    const events = scanAll(stream);
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.kind).toBe('directive');
    if (ev.kind !== 'directive') return;
    expect(ev.block).toBe(0);
    expect(ev.directive).toEqual({
      op: 'check',
      target: 'pc:alice',
      skill: '侦查',
      difficulty: 'normal',
      label: '翻查书桌',
    });
    expect(stream.slice(ev.start, ev.end)).toBe(fence(CHECK_JSON));
  });

  it('开栅栏行内直接跟 JSON（CommonMark 同行内容）也能解析', () => {
    const stream = `\`\`\`aidle ${CHECK_JSON}\n\`\`\`\n`;
    const events = scanAll(stream);
    expect(events).toMatchObject([{ kind: 'directive' }]);
  });

  it('CRLF 行尾与开栅栏尾随空白不干扰识别', () => {
    const crlf = `\`\`\`aidle\r\n${CHECK_JSON}\r\n\`\`\`\r\n`;
    expect(scanAll(crlf)).toMatchObject([{ kind: 'directive' }]);
    expect(scanAll('```aidle   \n' + CHECK_JSON + '\n```\n')).toMatchObject([
      { kind: 'directive' },
    ]);
  });

  it('闭合栅栏为流的最后一行（无尾随换行）也正常收块', () => {
    const events = scanAll(fence(CHECK_JSON));
    expect(events).toMatchObject([{ kind: 'directive' }]);
  });
});

describe('流式切分（跨 delta 缓冲）', () => {
  it('逐字符 feed 与整流 feed 产出完全一致', () => {
    const stream = `前文。\n${fence(CHECK_JSON)}\n${fence(CHECK_JSON)}\n尾。`;
    expect(JSON.stringify(scanAll(stream, 1))).toBe(JSON.stringify(scanAll(stream)));
  });

  it('delta 边界恰好切在栅栏与 JSON 中间不误触发', () => {
    const scanner = new DirectiveStreamScanner();
    expect(scanner.feed('叙事。\n```')).toEqual([]);
    expect(scanner.feed('aidle\n{"op": "che')).toEqual([]);
    expect(scanner.feed('ck", "target": "pc:bob", "skill": "聆听"}')).toEqual([]);
    const events = scanner.feed('\n```');
    expect(events).toEqual([]); // 闭合行无尾随换行，留待 flush 收块
    expect(scanner.flush()).toMatchObject([{ kind: 'directive', directive: { target: 'pc:bob' } }]);
  });

  it('空输入与重复 flush 均安全', () => {
    const scanner = new DirectiveStreamScanner();
    expect(scanner.feed('')).toEqual([]);
    expect(scanner.flush()).toEqual([]);
    expect(scanner.flush()).toEqual([]);
  });
});

describe('截断流（TC-FR-05-003）', () => {
  it('开栅栏无闭合 → flush 产 truncated，不产出指令', () => {
    const stream = `前文。\n\`\`\`aidle\n${CHECK_JSON}`;
    const events = scanAll(stream);
    expect(events).toEqual([{ kind: 'truncated', block: 0, start: stream.indexOf('```aidle') }]);
  });

  it('半截 JSON 的截断块不误触发（内容再像指令也不执行）', () => {
    const events = scanAll('```aidle\n{"op": "check", "target": "pc:ali');
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('truncated');
  });

  it('闭合块之后的截断块块序号继续递增', () => {
    const stream = `${fence(CHECK_JSON)}\n\`\`\`aidle\n{"op": "ch`;
    const events = scanAll(stream);
    expect(events).toMatchObject([
      { kind: 'directive', block: 0 },
      { kind: 'truncated', block: 1 },
    ]);
  });

  it('流以换行结尾的未闭合块同样走 flush 截断分支', () => {
    const stream = '```aidle\n';
    expect(scanAll(stream)).toEqual([{ kind: 'truncated', block: 0, start: 0 }]);
  });
});

describe('同一流内连续多指令块（TC-FR-05-004）', () => {
  it('多块按序全部处理，块序号与区间各自正确', () => {
    const b1 = fence(CHECK_JSON);
    const b2 = fence('{"op": "check", "target": "pc:bob", "skill": "聆听"}');
    const stream = `${b1}\n中间叙事。\n${b2}\n尾。`;
    const events = scanAll(stream);
    expect(events).toMatchObject([
      { kind: 'directive', block: 0, directive: { target: 'pc:alice' } },
      { kind: 'directive', block: 1, directive: { target: 'pc:bob' } },
    ]);
    const d0 = events[0]!;
    const d1 = events[1]!;
    expect(d0.kind === 'directive' && stream.slice(d0.start, d0.end)).toBe(b1);
    expect(d1.kind === 'directive' && stream.slice(d1.start, d1.end)).toBe(b2);
  });

  it('成功/解析失败/白名单拒绝/截断混排按序产出，R-01 可分别计数', () => {
    const badJson = fence('{"op": "check" 未闭合');
    const badOp = fence('{"op": "roll", "target": "pc:alice", "skill": "侦查"}');
    const stream = [
      fence(CHECK_JSON),
      badJson,
      badOp,
      '```aidle\n{"op": "check"', // 截断
    ].join('\n');
    const events = scanAll(stream);
    expect(events.map((ev) => ev.kind)).toEqual([
      'directive',
      'parse-error',
      'rejected',
      'truncated',
    ]);
    expect(events.map((ev) => ev.block)).toEqual([0, 1, 2, 3]);
    const pe = events[1]!;
    const rj = events[2]!;
    expect(pe.kind === 'parse-error' && pe.code).toBe('E-AI-01');
    expect(pe.kind === 'parse-error' && pe.raw).toBe('{"op": "check" 未闭合');
    expect(rj.kind === 'rejected' && rj.code).toBe('E-AI-01');
    expect(rj.kind === 'rejected' && rj.reason).toContain('未知 op');
  });

  it('空指令块（栅栏间无内容）归为 parse-error 而非静默', () => {
    expect(scanAll('```aidle\n```')).toMatchObject([{ kind: 'parse-error' }]);
  });
});

describe('不误触发（TC-FR-05-003 反向）', () => {
  it.each([
    ['行中出现的 ```aidle 不是开栅栏', '他念道：```aidle\n{"op": "check"}\n```\n'],
    ['普通代码块不触发', '```js\nconsole.log(1);\n```\n'],
    ['```aidlefoo 是别的语言标签', '```aidlefoo\n{"op": "check"}\n```\n'],
    ['纯叙事无事件', '今天侦探们来到宅邸。\n气氛凝重。\n'],
  ])('%s', (_name, stream) => {
    expect(scanAll(stream)).toEqual([]);
  });
});
