import type { WorldBook } from '@behindveil/shared';
import { stat } from 'node:fs/promises';
import type { DataLayout } from '../../adapters/storage/layout.js';
import { contentHash, WorldbookVectorIndex, VECTOR_INDEX_MAX_BYTES } from './vector-index.js';

/**
 * 混合召回编排（v3 T-M11-03，FR-33 / ADR-3-02/03，设计 §5.3）。
 *
 * 在管线**外**异步执行（查询嵌入是网络调用，管线保持同步纯函数）：
 * 1. 载入每房间向量缓存 `wb-vectors.jsonl`（进程内缓存 + mtime 失效）；
 * 2. 条目内容 hash 与缓存不符（或缺失）才调嵌入——嵌入调用频次 = 编辑频次；
 * 3. 内存硬顶 64MB：超出按 weight 从低到高截断并告警（NFR-11）；
 * 4. 查询向量 topK（K/阈值来自会话设置，默认 8 / 0.78）。
 *
 * 降级（可关断红线的另一半）：embed 未提供、嵌入调用失败、查询向量为空 →
 * 返回 null，本轮纯关键词召回 + trace 告警，叙事不阻塞（E-LLM-01 退避由适配器负责）。
 */

export type EmbedFn = (texts: string[]) => Promise<Float32Array[]>;

/** 会话设置缺省值（SessionSettings 可选字段的消费侧兜底，同 DEFAULT_NAT20_RULE 惯例） */
export const DEFAULT_VECTOR_RECALL_K = 8;
export const DEFAULT_VECTOR_RECALL_THRESHOLD = 0.78;

export interface RecallOutcome {
  hits: Array<{ uid: number; score: number }>;
  meta: {
    embeddedEntries: number;
    reusedEntries: number;
    memoryBytes: number;
    truncatedForMemory: boolean;
  };
  /** true = 已配置嵌入但本轮嵌入失败：S3.5 仍执行（trace 告警可见），但零并集 = 纯关键词 */
  degraded?: boolean;
  degradedReason?: string;
  /** 降级/截断等需要 KP 知晓的告警（进 trace 与日志） */
  warnings: string[];
}

/** 每房间索引缓存：mtime 变了就重载（编辑器/手编/AI 写路径都会动文件） */
const indexCache = new Map<string, { mtimeMs: number; index: WorldbookVectorIndex }>();

export async function prepareVectorRecall(opts: {
  layout: DataLayout;
  roomId: string;
  book: WorldBook;
  /** 与关键词扫描同源的查询语料（最近 scanDepth 条叙述文本） */
  queryTexts: string[];
  k: number;
  threshold: number;
  embed: EmbedFn;
  /** 进程内单测注入：跳过文件缓存（默认走缓存） */
  bypassCache?: boolean;
  /** 内存硬顶（默认 64MB，NFR-11）；测试注入小值验证截断语义 */
  maxMemoryBytes?: number;
}): Promise<RecallOutcome | null> {
  const warnings: string[] = [];
  const liveEntries = opts.book.entries.filter((e) => !e.disabled);
  if (liveEntries.length === 0) return null;

  // ---- 载入（带缓存）----
  const file = opts.layout.wbVectorsFile(opts.roomId);
  let index: WorldbookVectorIndex;
  if (opts.bypassCache === true) {
    index = new WorldbookVectorIndex();
    await index.load(file);
  } else {
    let mtimeMs = 0;
    try {
      mtimeMs = (await stat(file)).mtimeMs;
    } catch {
      mtimeMs = -1; // 文件尚不存在：空索引
    }
    const cached = indexCache.get(file);
    if (cached && cached.mtimeMs === mtimeMs) {
      index = cached.index;
    } else {
      index = new WorldbookVectorIndex();
      const badLines = await index.load(file);
      if (badLines > 0) {
        warnings.push(`向量缓存有 ${badLines} 条坏行已跳过（缓存可重建，不影响世界书本体）`);
      }
      indexCache.set(file, { mtimeMs, index });
    }
  }

  // ---- 缓存失效：内容变更才重嵌入 ----
  const validUids = new Set(liveEntries.map((e) => e.uid));
  const removed = index.removeExcept(validUids);
  const stale = liveEntries.filter((e) => index.get(e.uid)?.hash !== contentHash(e.content));
  let embeddedEntries = 0;
  if (stale.length > 0) {
    try {
      const vectors = await opts.embed(stale.map((e) => e.content));
      for (const [i, entry] of stale.entries()) {
        const vector = vectors[i];
        if (vector) index.upsert(entry.uid, contentHash(entry.content), vector);
      }
      embeddedEntries = stale.length;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      warnings.push(`嵌入调用失败，本轮回退纯关键词召回：${reason}`);
      // 降级但可观测：S3.5 照常执行并 trace 告警，零并集 = 纯关键词（prompt 字节同 v2.0）
      return {
        hits: [],
        meta: { embeddedEntries: 0, reusedEntries: 0, memoryBytes: 0, truncatedForMemory: false },
        degraded: true,
        degradedReason: reason,
        warnings,
      };
    }
  }

  // ---- 内存硬顶（默认 64MB，NFR-11）：按 weight 升序截断（低权重先出局）----
  const maxBytes = opts.maxMemoryBytes ?? VECTOR_INDEX_MAX_BYTES;
  let truncatedForMemory = false;
  const weightOf = (uid: number): number =>
    opts.book.entries.find((e) => e.uid === uid)?.weight ?? Number.MAX_SAFE_INTEGER;
  while (index.memoryBytes() > maxBytes) {
    const heaviest = index.allUids().sort((a, b) => weightOf(a) - weightOf(b))[0];
    if (heaviest === undefined) break;
    index.remove(heaviest);
    truncatedForMemory = true;
  }
  if (truncatedForMemory) {
    warnings.push(
      `向量索引超过 ${Math.round(maxBytes / 1024)}KB 内存硬顶，已按 weight 截断低权重条目`,
    );
  }

  // ---- 持久化（有变更才写）----
  if (embeddedEntries > 0 || removed > 0 || truncatedForMemory) {
    await index.persist(file);
    if (opts.bypassCache !== true) {
      try {
        const mtimeMs = (await stat(file)).mtimeMs;
        indexCache.set(file, { mtimeMs, index });
      } catch {
        indexCache.delete(file);
      }
    }
  }

  // ---- 查询向量 topK ----
  const queryText = opts.queryTexts.join('\n');
  if (queryText.trim() === '') return null;
  let queryVector: Float32Array;
  try {
    const [vector] = await opts.embed([queryText]);
    if (!vector) return null;
    queryVector = vector;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    warnings.push(`查询嵌入失败，本轮回退纯关键词召回：${reason}`);
    return {
      hits: [],
      meta: {
        embeddedEntries,
        reusedEntries: liveEntries.length - stale.length,
        memoryBytes: index.memoryBytes(),
        truncatedForMemory,
      },
      degraded: true,
      degradedReason: reason,
      warnings,
    };
  }

  const hits = index.search(queryVector, { k: opts.k, threshold: opts.threshold });
  return {
    hits,
    meta: {
      embeddedEntries,
      reusedEntries: liveEntries.length - stale.length,
      memoryBytes: index.memoryBytes(),
      truncatedForMemory,
    },
    warnings,
  };
}

/** 测试/CLI 用：清空进程内缓存（跨用例隔离） */
export function clearRecallCache(): void {
  indexCache.clear();
}
