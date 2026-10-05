import { readdir, rm } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { MessageSchema, type GlobalIndexEntry, type Message } from '@behindveil/shared';
import { JsonlStore } from '../adapters/storage/jsonl-store.js';
import { createDataLayout } from '../adapters/storage/layout.js';

/**
 * 跨房间全局消息索引（v3 T-M11-05，FR-34，设计 §5.3）。
 *
 * `data/index/global.jsonl` 追加型索引：消息持久化的同一房间队列操作内顺带追加
 * （零新增写路径——复用 JsonlStore append 语义，只是多一个文件）。
 * **索引永不写回原数据**，损坏即 `aidle-reindex` 全量重建；索引行冗余了 content，
 * /search 直接返回索引行，不再回源取详情（回源翻页走既有 GET /rooms/:id/messages）。
 *
 * 索引是管理面数据（Host 视角完整版，含暗骰标记）：/search 走 X-Admin-Token 门禁，
 * 与 GET /metrics 同一信任级别。
 */

/** 索引行契约在 shared（前后端共用），此处只做出口类型再导出 */
export type { GlobalIndexEntry } from '@behindveil/shared';

export interface GlobalSearchOptions {
  /** 过滤房间（缺省全房间） */
  roomId?: string;
  /** 单页条数，默认 50 */
  limit?: number;
}

export function indexEntryOf(
  roomId: string,
  sessionId: string,
  message: Message,
): GlobalIndexEntry {
  const base = {
    roomId,
    sessionId,
    seq: message.seq,
    type: message.type,
    // system 消息无 senderId（系统口播），dice 的 senderId 可选（缺省 = 引擎代掷）
    senderId: 'senderId' in message ? (message.senderId ?? '') : '',
    ts: message.ts,
  };
  switch (message.type) {
    case 'dice':
      return {
        ...base,
        hidden: message.hidden,
        content: `${message.roll.expr} = ${message.roll.total}`,
      };
    case 'state_snapshot':
      return { ...base, content: '' };
    default:
      return { ...base, content: message.content };
  }
}

export class GlobalIndex {
  private readonly store: JsonlStore;

  constructor(file: string) {
    // crashHook=false：索引不承载 WAP 语义，不参与故障注入计数（避免主链路崩溃点错位）
    this.store = new JsonlStore(file, { crashHook: false });
  }

  /** 追加一条索引行（调用方在消息落盘的同一队列操作内调用；失败由调用方告警不阻断） */
  async append(entry: GlobalIndexEntry): Promise<void> {
    await this.store.append(entry);
  }

  /** 关键词检索：content 子串匹配（与关键词扫描同一「大小写敏感」确定性口径），seq 降序 */
  async search(query: string, opts: GlobalSearchOptions = {}): Promise<GlobalIndexEntry[]> {
    const trimmed = query.trim();
    if (trimmed === '') return [];
    const { records, badLines } = await this.store.readAll();
    if (badLines > 0) {
      console.warn(`[global-index] 索引有 ${badLines} 条坏行（可用 aidle-reindex 重建）`);
    }
    const hits: GlobalIndexEntry[] = [];
    for (const record of records) {
      const entry = record as Partial<GlobalIndexEntry>;
      if (
        typeof entry.roomId !== 'string' ||
        typeof entry.sessionId !== 'string' ||
        typeof entry.seq !== 'number' ||
        typeof entry.content !== 'string'
      ) {
        continue;
      }
      if (opts.roomId !== undefined && entry.roomId !== opts.roomId) continue;
      if (!entry.content.includes(trimmed)) continue;
      hits.push(record as GlobalIndexEntry);
    }
    hits.sort((a, b) => b.seq - a.seq || a.roomId.localeCompare(b.roomId));
    return hits.slice(0, opts.limit ?? 50);
  }

  async close(): Promise<void> {
    await this.store.close();
  }
}

/**
 * 全量重建（aidle-reindex，FR-34）：**先删后建**——索引是派生数据，留着旧行会让
 * 重建结果叠加（重复命中）。删除动作放在这里而不是 CLI：重建函数自己保证幂等，
 * 调用方不必知道「要先删」这个前置条件。
 */
export async function rebuildGlobalIndex(
  dataDir: string,
): Promise<{ entries: number; badLines: number }> {
  const layout = createDataLayout(dataDir);
  await rm(layout.globalIndexFile, { force: true });
  const index = new GlobalIndex(layout.globalIndexFile);
  let entries = 0;
  let badLines = 0;

  let roomEntries: Dirent[];
  try {
    roomEntries = await readdir(layout.roomsDir, { withFileTypes: true });
  } catch {
    return { entries: 0, badLines: 0 };
  }

  for (const roomEntry of roomEntries) {
    if (!roomEntry.isDirectory()) continue;
    const roomId = roomEntry.name;
    let sessionEntries: Dirent[];
    try {
      sessionEntries = await readdir(layout.sessionsDir(roomId), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sessionEntry of sessionEntries) {
      if (!sessionEntry.isDirectory()) continue;
      const store = new JsonlStore(layout.messagesFile(roomId, sessionEntry.name));
      const { records, badLines: fileBad } = await store.readAll();
      badLines += fileBad;
      for (const record of records) {
        const parsed = MessageSchema.safeParse(record);
        if (!parsed.success) {
          badLines += 1;
          continue;
        }
        await index.append(indexEntryOf(roomId, sessionEntry.name, parsed.data));
        entries += 1;
      }
      await store.close();
    }
  }
  await index.close();
  return { entries, badLines };
}
