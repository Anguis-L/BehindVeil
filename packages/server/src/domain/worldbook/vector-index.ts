import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * 世界书向量索引（v3 T-M11-02，FR-33 / ADR-3-02，设计 §5.3）。
 *
 * 每房间一份 `rooms/<roomId>/wb-vectors.jsonl` 缓存（{uid, hash, dim, vector}），
 * 启动检索时载入内存 Float32Array 暴力内积 topK——万条 × 1536 维 ≈ 15M FLOP，
 * 毫秒级，零新增依赖。条目内容变更（hash 不等）才重嵌入：嵌入调用频次 = 编辑频次。
 *
 * 内存硬顶 64MB（NFR-11）：index 只报告占用，截断决策在召回服务层（它握有 weight）。
 * 本文件是缓存不是存档：损坏即整份丢弃重建，永不写回世界书本体。
 */

export const VECTOR_INDEX_MAX_BYTES = 64 * 1024 * 1024;

export interface VectorEntry {
  hash: string;
  dim: number;
  vector: Float32Array;
}

export interface SearchHit {
  uid: number;
  /** 余弦相似度（0..1 口径，已归一化内积） */
  score: number;
}

export class WorldbookVectorIndex {
  private readonly entries = new Map<number, VectorEntry>();

  /** 当前内存占用估算：dim × 4 字节/向量（Float32Array） */
  memoryBytes(): number {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.dim * 4;
    return total;
  }

  get(uid: number): VectorEntry | undefined {
    return this.entries.get(uid);
  }

  get size(): number {
    return this.entries.size;
  }

  allUids(): number[] {
    return [...this.entries.keys()];
  }

  upsert(uid: number, hash: string, vector: Float32Array): void {
    this.entries.set(uid, { hash, dim: vector.length, vector });
  }

  remove(uid: number): void {
    this.entries.delete(uid);
  }

  /** 丢弃不在 validUids 内的条目（世界书已删除的 uid），返回丢弃数 */
  removeExcept(validUids: ReadonlySet<number>): number {
    let removed = 0;
    for (const uid of [...this.entries.keys()]) {
      if (!validUids.has(uid)) {
        this.entries.delete(uid);
        removed += 1;
      }
    }
    return removed;
  }

  /** 从 JSONL 载入（坏行跳过并计数）；文件不存在 = 空索引 */
  async load(file: string): Promise<number> {
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw err;
    }
    let badLines = 0;
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const record = JSON.parse(line) as {
          uid?: unknown;
          hash?: unknown;
          dim?: unknown;
          vector?: unknown;
        };
        if (
          typeof record.uid !== 'number' ||
          typeof record.hash !== 'string' ||
          !Array.isArray(record.vector)
        ) {
          badLines += 1;
          continue;
        }
        this.entries.set(record.uid, {
          hash: record.hash,
          dim: record.vector.length,
          vector: new Float32Array(record.vector as number[]),
        });
      } catch {
        badLines += 1;
      }
    }
    return badLines;
  }

  /** 全量原子重写（tmp + rename）；写前 fsync，崩在任意点旧文件完好 */
  async persist(file: string): Promise<void> {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    const handle = await open(tmp, 'w');
    try {
      for (const [uid, entry] of this.entries) {
        await handle.write(
          `${JSON.stringify({ uid, hash: entry.hash, dim: entry.dim, vector: [...entry.vector] })}\n`,
          null,
          'utf8',
        );
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, file);
  }

  /**
   * 暴力余弦 topK：score ≥ threshold 的前 k 名，降序。向量未归一化时按真实余弦计
   * （点积除以双方模长）。O(n×dim)；查询向量按需归一化，不改调用方传入的数组。
   */
  search(
    query: Float32Array,
    opts: { k: number; threshold: number; candidates?: ReadonlySet<number> },
  ): SearchHit[] {
    let queryNorm = 0;
    for (const v of query) queryNorm += v * v;
    queryNorm = Math.sqrt(queryNorm);
    if (queryNorm === 0) return [];

    const hits: SearchHit[] = [];
    for (const [uid, entry] of this.entries) {
      if (opts.candidates && !opts.candidates.has(uid)) continue;
      if (entry.vector.length !== query.length) continue; // 维度不符（换模型残留），跳过
      let dot = 0;
      let vectorNorm = 0;
      for (let i = 0; i < query.length; i += 1) {
        const q = query[i] as number;
        const v = entry.vector[i] as number;
        dot += q * v;
        vectorNorm += v * v;
      }
      vectorNorm = Math.sqrt(vectorNorm);
      if (vectorNorm === 0) continue;
      const score = dot / (queryNorm * vectorNorm);
      if (score >= opts.threshold) hits.push({ uid, score });
    }
    return hits.sort((a, b) => b.score - a.score || a.uid - b.uid).slice(0, Math.max(0, opts.k));
  }
}

/** 条目内容哈希（缓存失效键）：sha256 前 16 位足够防碰撞（同房间条目量级） */
export function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}
