import { describe, expect, it, vi } from 'vitest';
import type { WorldBook, WorldBookEntry } from '@behindveil/shared';
import { scanWorldBook } from './scan.js';

/**
 * 世界书扫描语义单测（T-M2-02，测试文档 §6.1 TC-FR-07-001~010）。
 * scanDepth 切片归管线 S3（见 pipeline 测试），本文件只验证匹配语义。
 */

let nextUid = 1;
function entry(overrides: Partial<WorldBookEntry>): WorldBookEntry {
  return {
    uid: nextUid++,
    key: [],
    keysecondary: [],
    selectiveLogic: 0,
    content: `条目${overrides.uid ?? ''}`,
    position: 'after_char',
    order: 0,
    weight: 100,
    constant: false,
    disabled: false,
    ...overrides,
  };
}

function book(...entries: WorldBookEntry[]): WorldBook {
  return { entries };
}

describe('世界书扫描（TDD §5.2）', () => {
  it('TC-FR-07-001：constant=true 无视扫描文本恒命中', () => {
    const hit = scanWorldBook(
      ['完全不相关的文本'],
      book(entry({ uid: 7, constant: true, key: ['不存在的词'] })),
    );

    expect(hit).toHaveLength(1);
    expect(hit[0]?.entry.uid).toBe(7);
  });

  it('TC-FR-07-002：主关键词子串命中（中英混合文本）', () => {
    const hit = scanWorldBook(
      ['He pushed open the study door and pulled out a drawer.'],
      book(entry({ key: ['study'] })),
    );

    expect(hit).toHaveLength(1);
    expect(hit[0]?.matchedKeys).toEqual(['study']);

    const zh = scanWorldBook(['我推开书房的门，检查书桌抽屉。'], book(entry({ key: ['书房'] })));
    expect(zh).toHaveLength(1);
  });

  it('TC-FR-07-003：/regex/ 形式命中；非法正则降级为字面量并告警，不崩溃', () => {
    const regexHit = scanWorldBook(['密码是 4077'], book(entry({ key: ['/40\\d{2}/'] })));
    expect(regexHit).toHaveLength(1);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const degraded = scanWorldBook(
        ['原文里出现 /bad(/ 字面量'],
        book(entry({ key: ['/bad(/'] })),
      );
      expect(degraded).toHaveLength(1);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }

    expect(scanWorldBook(['不含目标'], book(entry({ key: ['/40\\d{2}/'] })))).toHaveLength(0);
  });

  it('TC-FR-07-004：空 keysecondary，primary 命中即命中', () => {
    const hit = scanWorldBook(['提到旧教堂'], book(entry({ key: ['教堂'], keysecondary: [] })));
    expect(hit).toHaveLength(1);
  });

  it('TC-FR-07-005：AND_ANY(0) primary 命中且 secondary 任一命中', () => {
    const e = entry({ key: ['教堂'], keysecondary: ['钟楼', '地窖'], selectiveLogic: 0 });

    expect(scanWorldBook(['教堂的钟楼 Lock'], book(e))).toHaveLength(1);
    expect(scanWorldBook(['教堂没有别的'], book(e))).toHaveLength(0);
  });

  it('TC-FR-07-006：AND_ALL(3) primary 命中且 secondary 全命中', () => {
    const e = entry({ key: ['教堂'], keysecondary: ['钟楼', '地窖'], selectiveLogic: 3 });

    expect(scanWorldBook(['教堂的钟楼连着地窖'], book(e))).toHaveLength(1);
    expect(scanWorldBook(['教堂的钟楼而已'], book(e))).toHaveLength(0);
  });

  it('TC-FR-07-007：NOT_ALL(1) primary 命中且 secondary 非全命中', () => {
    const e = entry({ key: ['教堂'], keysecondary: ['钟楼', '地窖'], selectiveLogic: 1 });

    expect(scanWorldBook(['教堂的钟楼而已'], book(e))).toHaveLength(1);
    expect(scanWorldBook(['教堂的钟楼连着地窖'], book(e))).toHaveLength(0);
  });

  it('TC-FR-07-008：NOT_ANY(2) primary 命中且 secondary 零命中', () => {
    const e = entry({ key: ['教堂'], keysecondary: ['钟楼', '地窖'], selectiveLogic: 2 });

    expect(scanWorldBook(['教堂空无一人'], book(e))).toHaveLength(1);
    expect(scanWorldBook(['教堂的钟楼'], book(e))).toHaveLength(0);
  });

  it('TC-FR-07-009：disabled=true / 空 key 条目永不命中', () => {
    expect(
      scanWorldBook(['关键词在这里'], book(entry({ disabled: true, key: ['关键词'] }))),
    ).toHaveLength(0);
    expect(scanWorldBook(['关键词在这里'], book(entry({ key: [] })))).toHaveLength(0);
  });

  it('TC-FR-07-010：递归 1 层——命中条目 content 参与下一轮扫描；自引用不死循环', () => {
    // A 的 content 含 B 的关键词：仅递归才命中 B
    const a = entry({ uid: 1, key: ['起点'], content: '通往密道的入口' });
    const b = entry({ uid: 2, key: ['密道'], content: '密道尽头是祭坛' });
    const hits = scanWorldBook(['故事的起点'], book(a, b));
    expect(hits.map((h) => h.entry.uid)).toEqual([1, 2]);

    // recursionDepth=0 关闭递归：B 不命中
    expect(scanWorldBook(['故事的起点'], book(a, b), { recursionDepth: 0 })).toHaveLength(1);

    // 自引用：content 包含自身关键词，uid 去重 + 轮数上限保证不死循环
    const self = entry({ uid: 3, key: ['镜子'], content: '镜中还有镜子' });
    const selfHits = scanWorldBook(['他盯着镜子'], book(self));
    expect(selfHits).toHaveLength(1);
    expect(selfHits[0]?.entry.uid).toBe(3);
  });

  it('多条文本拼接扫描：任一条命中即算（corpus = texts.join）', () => {
    const hits = scanWorldBook(['第一句无关', '第二句提到码头'], book(entry({ key: ['码头'] })));
    expect(hits).toHaveLength(1);
  });

  it('命中详情带 matchedSecondary（进 trace 供预览）', () => {
    const hits = scanWorldBook(
      ['教堂的钟楼响了'],
      book(entry({ key: ['教堂'], keysecondary: ['钟楼'], selectiveLogic: 0 })),
    );

    expect(hits[0]?.matchedKeys).toEqual(['教堂']);
    expect(hits[0]?.matchedSecondary).toEqual(['钟楼']);
  });
});
