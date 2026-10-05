import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { contentHash, WorldbookVectorIndex, VECTOR_INDEX_MAX_BYTES } from './vector-index.js';

/**
 * 向量索引单测（v3 T-M11-02，FR-33 / ADR-3-02）：
 * JSONL 持久化 roundtrip 与坏行容错、hash 缓存失效语义、余弦 topK
 * （阈值过滤 / k 截断 / 维度不符跳过 / 零向量）、64MB 硬顶报告口径。
 */

const created: string[] = [];

function vector(seed: number, dim = 4): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i += 1) v[i] = Math.sin(seed + i);
  return v;
}

afterAll(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('WorldbookVectorIndex', () => {
  it('persist → load roundtrip；坏行跳过并计数', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bv-vindex-'));
    created.push(dir);
    const file = path.join(dir, 'wb-vectors.jsonl');

    const index = new WorldbookVectorIndex();
    index.upsert(1, contentHash('灯塔'), vector(1));
    index.upsert(2, contentHash('雾桥'), vector(2));
    await index.persist(file);

    const reloaded = new WorldbookVectorIndex();
    const bad = await reloaded.load(file);
    expect(bad).toBe(0);
    expect(reloaded.get(1)?.hash).toBe(contentHash('灯塔'));
    expect([...(reloaded.get(1)?.vector ?? [])]).toEqual([...vector(1)]);

    // 手工追加坏行后重载：跳过不崩溃
    const raw = await readFile(file, 'utf8');
    await import('node:fs/promises').then((fs) =>
      fs.writeFile(file, `${raw}not-json\n{"uid":9}\n`, 'utf8'),
    );
    const broken = new WorldbookVectorIndex();
    expect(await broken.load(file)).toBe(2);
    expect(broken.size).toBe(2);
  });

  it('文件不存在 → 空索引（首次检索）', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bv-vindex-'));
    created.push(dir);
    const index = new WorldbookVectorIndex();
    expect(await index.load(path.join(dir, 'nope.jsonl'))).toBe(0);
    expect(index.size).toBe(0);
  });

  it('removeExcept 丢弃已删除条目并回报数量', () => {
    const index = new WorldbookVectorIndex();
    index.upsert(1, 'h1', vector(1));
    index.upsert(2, 'h2', vector(2));
    index.upsert(3, 'h3', vector(3));
    expect(index.removeExcept(new Set([1, 3]))).toBe(1);
    expect(index.allUids().sort()).toEqual([1, 3]);
  });

  it('余弦 topK：阈值过滤 + k 截断 + 降序 + 候选集', () => {
    const index = new WorldbookVectorIndex();
    const base = new Float32Array([1, 0, 0, 0]);
    index.upsert(1, 'h', base);
    index.upsert(2, 'h', new Float32Array([0.9, 0.1, 0, 0]));
    index.upsert(3, 'h', new Float32Array([0, 1, 0, 0])); // 与查询正交
    index.upsert(4, 'h', new Float32Array([-1, 0, 0, 0])); // 反向

    const hits = index.search(base, { k: 10, threshold: 0.5 });
    expect(hits.map((h) => h.uid)).toEqual([1, 2]); // 3 正交 0 分、4 反向负分，均被阈值滤掉
    expect(hits[0]?.score).toBeCloseTo(1, 6);

    expect(index.search(base, { k: 1, threshold: 0.5 })).toEqual([
      { uid: 1, score: expect.any(Number) },
    ]);

    // 候选集限制（如 weight 截断后的存活集）；threshold=-1 连反向向量也纳入
    const capped = index.search(base, { k: 10, threshold: -1, candidates: new Set([3, 4]) });
    expect(capped.map((h) => h.uid).sort()).toEqual([3, 4]);
  });

  it('维度不符的残留向量跳过不崩溃；零查询向量返回空', () => {
    const index = new WorldbookVectorIndex();
    index.upsert(1, 'h', new Float32Array([1, 0])); // 2 维（换嵌入模型后的残留）
    index.upsert(2, 'h', new Float32Array([1, 0, 0, 0]));
    const hits = index.search(new Float32Array([1, 0, 0, 0]), { k: 10, threshold: 0.5 });
    expect(hits.map((h) => h.uid)).toEqual([2]);
    expect(index.search(new Float32Array(4), { k: 5, threshold: 0 })).toEqual([]);
  });

  it('memoryBytes 按 dim×4 估算；常量硬顶 = 64MB', () => {
    const index = new WorldbookVectorIndex();
    index.upsert(1, 'h', new Float32Array(1536));
    expect(index.memoryBytes()).toBe(1536 * 4);
    expect(VECTOR_INDEX_MAX_BYTES).toBe(64 * 1024 * 1024);
  });

  it('contentHash：同文本同哈希，异文本异哈希', () => {
    expect(contentHash('灯塔在雾中')).toBe(contentHash('灯塔在雾中'));
    expect(contentHash('灯塔在雾中')).not.toBe(contentHash('灯塔在雾外'));
  });
});
