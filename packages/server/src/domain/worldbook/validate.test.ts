import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadWorldBook, validateWorldBook } from './validate.js';
import { createDataLayout } from '../../adapters/storage/layout.js';

/**
 * 世界书载入校验器单测（T-M2-06，决议 D-08：JSON 手编 + 载入校验，无编辑 UI）。
 * 结构错误拒绝载入；语义隐患告警放行（与扫描降级容错一致）。
 */

describe('validateWorldBook', () => {
  it('合法世界书：ok + 命中 book，weight 缺省补 100', () => {
    const result = validateWorldBook({
      entries: [
        {
          uid: 1,
          key: ['书房'],
          keysecondary: [],
          selectiveLogic: 0,
          content: '书房场景',
          position: 'after_char',
          order: 0,
          constant: false,
          disabled: false,
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.book?.entries[0]?.weight).toBe(100);
    expect(result.errors).toEqual([]);
  });

  it('Schema 不符（key 非数组）→ 拒绝并带路径', () => {
    const result = validateWorldBook({
      entries: [
        {
          uid: 1,
          key: '书房',
          keysecondary: [],
          selectiveLogic: 0,
          content: '',
          position: 'after_char',
          order: 0,
          constant: false,
          disabled: false,
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('key');
  });

  it('uid 重复 → 拒绝（uid 是 trace 与递归去重的键）', () => {
    const entry = {
      key: ['x'],
      keysecondary: [],
      selectiveLogic: 0,
      content: '',
      position: 'after_char',
      order: 0,
      constant: false,
      disabled: false,
    };
    const result = validateWorldBook({
      entries: [
        { uid: 1, ...entry },
        { uid: 1, ...entry },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('uid 重复');
  });

  it('position=at_depth 缺 depth → 拒绝', () => {
    const result = validateWorldBook({
      entries: [
        {
          uid: 1,
          key: ['x'],
          keysecondary: [],
          selectiveLogic: 0,
          content: '',
          position: 'at_depth',
          order: 0,
          constant: false,
          disabled: false,
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('depth');
  });

  it('非常驻条目 key 为空 → 告警放行；非法正则 → 告警放行', () => {
    const result = validateWorldBook({
      entries: [
        {
          uid: 1,
          key: [],
          keysecondary: [],
          selectiveLogic: 0,
          content: '',
          position: 'after_char',
          order: 0,
          constant: false,
          disabled: false,
        },
        {
          uid: 2,
          key: ['/bad(/'],
          keysecondary: [],
          selectiveLogic: 0,
          content: '',
          position: 'after_char',
          order: 0,
          constant: false,
          disabled: false,
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.warnings.join('\n')).toContain('key 为空');
    expect(result.warnings.join('\n')).toContain('非法正则');
  });
});

describe('loadWorldBook', () => {
  it('文件不存在 → 空 WorldBook（手编可选）', async () => {
    const layout = createDataLayout('/nonexistent-bv-test');
    const { book, warnings } = await loadWorldBook(layout, 'room_x');

    expect(book.entries).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('JSON 坏 → 抛错（载入时拦截）', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bv-wb-'));
    try {
      const layout = createDataLayout(dir);
      await mkdir(path.join(dir, 'rooms', 'r1'), { recursive: true });
      await writeFile(layout.worldbookFile('r1'), '{ broken', 'utf8');

      await expect(loadWorldBook(layout, 'r1')).rejects.toThrow('JSON 解析失败');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
