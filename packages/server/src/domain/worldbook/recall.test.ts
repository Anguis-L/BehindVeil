import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { WorldBook, WorldBookEntry } from '@behindveil/shared';
import { createDataLayout } from '../../adapters/storage/layout.js';
import {
  clearRecallCache,
  DEFAULT_VECTOR_RECALL_K,
  DEFAULT_VECTOR_RECALL_THRESHOLD,
  prepareVectorRecall,
  type EmbedFn,
} from './recall.js';
import { contentHash, WorldbookVectorIndex } from './vector-index.js';

/**
 * 混合召回编排单测（v3 T-M11-03，FR-33）：
 * hash 缓存失效（嵌入频次 = 编辑频次）、删除条目清理、topK 透传、
 * 内存硬顶按 weight 截断并告警、嵌入失败降级（零并集 + degraded 告警）。
 */

const created: string[] = [];

function entry(uid: number, content: string, weight = 100): WorldBookEntry {
  return {
    uid,
    key: [],
    keysecondary: [],
    selectiveLogic: 0,
    content,
    position: 'after_char',
    order: uid,
    weight,
    constant: false,
    disabled: false,
  };
}

function book(entries: WorldBookEntry[]): WorldBook {
  return { entries };
}

async function makeDir(): Promise<ReturnType<typeof createDataLayout>> {
  const root = await mkdtemp(path.join(tmpdir(), 'bv-recall-'));
  created.push(root);
  return createDataLayout(root);
}

afterAll(async () => {
  clearRecallCache();
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('prepareVectorRecall', () => {
  it('首次：全量条目批量嵌入 + 持久化缓存；topK 命中回传', async () => {
    const layout = await makeDir();
    const bookV1 = book([entry(1, '灯塔在雾中', 100), entry(2, '驿站的后门', 50)]);
    const calls: string[][] = [];
    const embed: EmbedFn = async (texts) => {
      calls.push(texts);
      return texts.map((t) =>
        t === '灯塔在雾中' ? new Float32Array([1, 0, 0.2]) : new Float32Array([0, 1, 0.9]),
      );
    };

    const outcome = await prepareVectorRecall({
      layout,
      roomId: 'r1',
      book: bookV1,
      queryTexts: ['灯塔在雾中'],
      k: 2,
      threshold: 0.5,
      embed,
      bypassCache: true,
    });

    expect(outcome).not.toBeNull();
    expect(outcome?.meta.embeddedEntries).toBe(2);
    expect(outcome?.meta.reusedEntries).toBe(0);
    expect(outcome?.degraded ?? false).toBe(false);
    expect(calls[0]).toEqual(['灯塔在雾中', '驿站的后门']); // 条目批量一次
    expect(calls[1]).toEqual(['灯塔在雾中']); // 查询单独一次
    expect(outcome?.hits[0]?.uid).toBe(1); // 与查询最近 → 最高分

    const index = new WorldbookVectorIndex();
    await index.load(layout.wbVectorsFile('r1'));
    expect(index.size).toBe(2);
    expect(index.get(1)?.hash).toBe(contentHash('灯塔在雾中'));
  });

  it('第二轮：内容未变零嵌入，内容变更只嵌变更条目', async () => {
    const layout = await makeDir();
    await prepareVectorRecall({
      layout,
      roomId: 'r2',
      book: book([entry(1, '灯塔在雾中'), entry(2, '驿站的后门')]),
      queryTexts: ['灯塔'],
      k: 4,
      threshold: 0.1,
      embed: async (texts) => texts.map(() => new Float32Array([1, 0, 0, 0])),
      bypassCache: true,
    });

    let entryEmbedCalls = 0;
    const outcome = await prepareVectorRecall({
      layout,
      roomId: 'r2',
      book: book([entry(1, '灯塔在雾中（修缮后）'), entry(2, '驿站的后门')]),
      queryTexts: ['灯塔'],
      k: 4,
      threshold: 0.1,
      embed: async (texts) => {
        // 查询嵌入是单文本调用；条目嵌入批量 ≥2（本例恰好 1 条变更 + 1 条查询）
        if (texts.length > 1 || entryEmbedCalls === 0) entryEmbedCalls += 1;
        return texts.map(() => new Float32Array([0, 1, 0, 0]));
      },
      bypassCache: true,
    });

    expect(outcome?.meta.embeddedEntries).toBe(1); // 只嵌变更条目
    expect(outcome?.meta.reusedEntries).toBe(1);
  });

  it('世界书删除条目 → 缓存清理且不重嵌未变条目', async () => {
    const layout = await makeDir();
    await prepareVectorRecall({
      layout,
      roomId: 'r3',
      book: book([entry(1, '甲'), entry(2, '乙')]),
      queryTexts: ['甲'],
      k: 4,
      threshold: -1,
      embed: async (texts) => texts.map(() => new Float32Array([1, 0, 0, 0])),
      bypassCache: true,
    });

    const outcome = await prepareVectorRecall({
      layout,
      roomId: 'r3',
      book: book([entry(1, '甲')]), // 条目 2 被删
      queryTexts: ['甲'],
      k: 4,
      threshold: -1,
      embed: async (texts) => texts.map(() => new Float32Array([1, 0, 0, 0])),
      bypassCache: true,
    });
    expect(outcome?.meta.embeddedEntries).toBe(0);

    const index = new WorldbookVectorIndex();
    await index.load(layout.wbVectorsFile('r3'));
    expect(index.allUids()).toEqual([1]);
  });

  it('内存硬顶：weight 最低的条目先被截断并告警，topK 只在存活集里找', async () => {
    const layout = await makeDir();
    const bookV1 = book([entry(1, '高权重', 900), entry(2, '低权重', 10), entry(3, '中权重', 500)]);
    await prepareVectorRecall({
      layout,
      roomId: 'r4',
      book: bookV1,
      queryTexts: ['高权重'],
      k: 4,
      threshold: -1,
      embed: async (texts) => texts.map(() => new Float32Array(16).fill(1)), // 64B/条
      bypassCache: true,
    });

    // 二轮把硬顶压到 128B：三条 192B → 截掉 weight 最低的条目 2，剩两条 128B
    const outcome = await prepareVectorRecall({
      layout,
      roomId: 'r4',
      book: bookV1,
      queryTexts: ['高权重'],
      k: 4,
      threshold: -1,
      embed: async (texts) => texts.map(() => new Float32Array(16).fill(1)),
      bypassCache: true,
      maxMemoryBytes: 128,
    });

    expect(outcome?.meta.truncatedForMemory).toBe(true);
    expect(outcome?.warnings.join('\n')).toMatch(/硬顶/);
    expect(outcome?.hits.every((h) => h.uid !== 2)).toBe(true);

    const index = new WorldbookVectorIndex();
    await index.load(layout.wbVectorsFile('r4'));
    expect(index.allUids().sort()).toEqual([1, 3]);
    expect(index.memoryBytes()).toBeLessThanOrEqual(128);
  });

  it('嵌入失败 → 降级：零并集 + degraded 告警，不抛错不阻塞', async () => {
    const layout = await makeDir();
    const outcome = await prepareVectorRecall({
      layout,
      roomId: 'r5',
      book: book([entry(1, '甲')]),
      queryTexts: ['甲'],
      k: 4,
      threshold: 0.5,
      embed: async () => {
        throw new Error('ECONNREFUSED 模拟嵌入服务不可用');
      },
      bypassCache: true,
    });
    expect(outcome?.degraded).toBe(true);
    expect(outcome?.hits).toEqual([]);
    expect(outcome?.degradedReason).toContain('ECONNREFUSED');
    expect(outcome?.warnings.join('\n')).toMatch(/回退纯关键词/);
  });

  it('全禁用世界书 → null（S3.5 跳过）', async () => {
    const layout = await makeDir();
    const disabled = { ...entry(1, '甲'), disabled: true };
    const outcome = await prepareVectorRecall({
      layout,
      roomId: 'r6',
      book: book([disabled]),
      queryTexts: ['甲'],
      k: 4,
      threshold: 0.5,
      embed: async (texts) => texts.map(() => new Float32Array([1])),
      bypassCache: true,
    });
    expect(outcome).toBeNull();
  });
});

describe('缺省值', () => {
  it('K=8 / 阈值 0.78（设计 §5.3）', () => {
    expect(DEFAULT_VECTOR_RECALL_K).toBe(8);
    expect(DEFAULT_VECTOR_RECALL_THRESHOLD).toBe(0.78);
  });
});
