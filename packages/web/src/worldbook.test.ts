import { describe, expect, it } from 'vitest';
import type { WorldBookEntry } from '@behindveil/shared';
import {
  copyIntoRoom,
  draftFromEntry,
  emptyDraft,
  entryFromDraft,
  nextUid,
  parseKeywordText,
  validateDraft,
  virtualWindow,
} from './worldbook.js';

/**
 * 世界书编辑器纯逻辑（v3 T-M11-06，FR-35）。
 *
 * 三条要害：① 表单 ↔ 落盘条目是双向无损的（roundtrip 丢字段等于静默改用户世界书）；
 * ② 客户端预校验与服务端同判据（at_depth 缺 depth / 空关键词）；
 * ③ 虚拟滚动窗口算得对——算错就是列表渲染错位或空白。
 */

const entry: WorldBookEntry = {
  uid: 7,
  key: ['灯塔', '雾'],
  keysecondary: ['泊位'],
  selectiveLogic: 3,
  content: '泊位边的长明灯。',
  position: 'at_depth',
  depth: 2,
  order: 50,
  weight: 80,
  constant: false,
  disabled: false,
  extensions: { kpOnly: true },
};

describe('关键词切分', () => {
  it('逗号 / 中文逗号 / 换行都能切，去空白与空项', () => {
    expect(parseKeywordText('灯塔, 雾，泊位\n码头')).toEqual(['灯塔', '雾', '泊位', '码头']);
    expect(parseKeywordText('  ,  , ')).toEqual([]);
  });
});

describe('草稿 ↔ 条目 roundtrip', () => {
  it('条目 → 草稿 → 条目：字段无损', () => {
    const back = entryFromDraft(draftFromEntry(entry));
    expect(back).toEqual(entry);
  });

  it('kpOnly 只在该扩展为真时写入（不给所有条目挂空 extensions）', () => {
    const plain: WorldBookEntry = { ...entry, extensions: undefined };
    expect(entryFromDraft(draftFromEntry(plain)).extensions).toBeUndefined();
  });

  it('at_depth 带 depth；非 at_depth 且未填 depth 时不产出该字段', () => {
    const draft = draftFromEntry({ ...entry, position: 'before_char', depth: undefined });
    const back = entryFromDraft(draft);
    expect(back.position).toBe('before_char');
    expect('depth' in back).toBe(false);
  });

  it('新建条目 uid 取现有最大值 +1（uid 不复用）', () => {
    expect(nextUid([])).toBe(1);
    expect(nextUid([entry, { ...entry, uid: 42 }])).toBe(43);
    expect(emptyDraft(nextUid([entry])).uid).toBe(8);
  });
});

describe('客户端预校验（与服务端 validateWorldBook 同判据）', () => {
  it('at_depth 缺 depth / 非法 depth → error', () => {
    const base = draftFromEntry(entry);
    expect(validateDraft({ ...base, depth: '' }).depth).toMatch(/非负整数/);
    expect(validateDraft({ ...base, depth: '-1' }).depth).toMatch(/非负整数/);
    expect(validateDraft({ ...base, depth: '2' }).depth).toBeUndefined();
  });

  it('内容为空 → error；非常驻且无关键词 → notice（不是 error，允许保存）', () => {
    // 基线取「普通条目」：entry 自带 kpOnly，会合法地跳过关键词告警
    const base = { ...draftFromEntry(entry), kpOnly: false };
    expect(validateDraft({ ...base, content: '  ' }).content).toMatch(/内容不可为空/);

    const noKey = validateDraft({ ...base, keyText: '' });
    expect(noKey.notice).toMatch(/永远不会命中/);

    // 常驻或 KP 专属条目没有关键词是合法的（它们不靠关键词命中）
    expect(validateDraft({ ...base, keyText: '', constant: true }).notice).toBeUndefined();
    expect(validateDraft({ ...base, keyText: '', kpOnly: true }).notice).toBeUndefined();
  });
});

describe('模组世界书复制到房间层', () => {
  const modEntry: WorldBookEntry = { ...entry, uid: 1, key: ['旧航图'] };

  it('uid 重排，不与房间现有 uid 相撞', () => {
    const room: WorldBookEntry[] = [{ ...entry, uid: 5, content: '房间已有条目' }];
    const result = copyIntoRoom(room, [modEntry]);
    expect(result.added).toBe(1);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[1]!.uid).toBe(6);
    expect(result.entries[1]!.key).toEqual(['旧航图']);
  });

  it('内容相同的条目不重复复制（连点两次不会把世界书翻倍）', () => {
    const room: WorldBookEntry[] = [modEntry];
    const result = copyIntoRoom(room, [modEntry]);
    expect(result.added).toBe(0);
    expect(result.entries).toHaveLength(1);
  });
});

describe('虚拟滚动窗口', () => {
  it('顶部：从 0 开始，含 overscan 缓冲', () => {
    const w = virtualWindow({ itemCount: 1000, rowHeight: 40, scrollTop: 0, viewportHeight: 360 });
    expect(w.start).toBe(0);
    expect(w.end).toBe(15); // ceil(360/40)+1 + overscan(5)
    expect(w.totalHeight).toBe(40_000);
    expect(w.offsetTop).toBe(0);
  });

  it('中部：offsetTop 与 start 对齐（错位会导致列表跳白）', () => {
    const w = virtualWindow({
      itemCount: 1000,
      rowHeight: 40,
      scrollTop: 4000,
      viewportHeight: 360,
    });
    expect(w.start).toBe(95);
    expect(w.offsetTop).toBe(w.start * 40);
  });

  it('底部：end 不越界；空列表不产出负区间', () => {
    const w = virtualWindow({
      itemCount: 100,
      rowHeight: 40,
      scrollTop: 10_000,
      viewportHeight: 360,
    });
    expect(w.end).toBe(99);
    expect(w.end).toBeLessThan(100);

    const empty = virtualWindow({
      itemCount: 0,
      rowHeight: 40,
      scrollTop: 0,
      viewportHeight: 360,
    });
    expect(empty.end).toBe(-1);
    expect(empty.totalHeight).toBe(0);
  });
});
