import { SCHEMA_VERSION, migrateArchive, type WorldBook } from '@behindveil/shared';
import { JsonStore } from '../../adapters/storage/json-store.js';
import type { DataLayout } from '../../adapters/storage/layout.js';
import { validateWorldBook, type WorldBookLoadResult } from './validate.js';

/**
 * 房间世界书读写（v3 T-M11-06，FR-35，设计 §5.3）。
 *
 * v1–v2 只有「手编 + 载入校验」：服务端从无写路径，世界书是纯用户资产（D-08）。
 * 编辑器落地后服务端第一次握有写权限，因此同步收编进迁移管辖（ADR-3-05 章程）：
 * - 落盘信封 `{ schemaVersion, entries }`，与 room/members 等同一口径；
 * - 读时先 `migrateArchive('worldbook')` 再校验——手编的裸 `{entries}`（版本 0）
 *   照样能读，不强制用户先跑迁移；
 * - 写时校验在前（D-08 不变：结构错误拒绝落盘，语义隐患告警放行）。
 *
 * 模组层世界书不在此列：它是模组包内的资产，只读，要改就「复制到房间层再改」。
 */

/** 房间世界书文件（房间级，与模组包内世界书区分） */
function storeFor(layout: DataLayout, roomId: string): JsonStore {
  return new JsonStore(layout.worldbookFile(roomId));
}

/**
 * 载入房间世界书（供管线与编辑器共用同一口径）。
 * 文件不存在 → 空世界书（手编可选）；JSON 坏或结构错误 → 抛错（载入时拦截）。
 */
export async function readRoomWorldBook(
  layout: DataLayout,
  roomId: string,
): Promise<WorldBookLoadResult> {
  let raw: unknown | null;
  try {
    raw = await storeFor(layout, roomId).read();
  } catch (err) {
    // 文案与 v1/v2 一致（载入错误要能一眼看出是「文件坏了」还是「读不到」）：
    // JsonStore.read 只有 JSON.parse 与 IO 两种失败，分别归位。
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof SyntaxError) {
      throw new Error(`世界书 JSON 解析失败：${message}`);
    }
    throw new Error(`世界书读取失败：${message}`);
  }
  if (raw === null) return { book: { entries: [] }, warnings: [] };

  // 版本迁移：裸 {entries} 视作版本 0，迁移后仍是 {schemaVersion, entries}
  const migrated = migrateArchive('worldbook', raw);
  const payload =
    migrated !== null && typeof migrated === 'object'
      ? (() => {
          const { schemaVersion: _schemaVersion, ...rest } = migrated as Record<string, unknown>;
          return rest;
        })()
      : migrated;

  const result = validateWorldBook(payload);
  if (!result.ok || result.book === null) {
    throw new Error(`世界书校验未通过：\n${result.errors.join('\n')}`);
  }
  return { book: result.book, warnings: result.warnings };
}

export interface WriteWorldBookResult {
  book: WorldBook;
  warnings: string[];
}

/**
 * 写入房间世界书（编辑器唯一写入口）：校验 → 原子写（tmp + fsync + rename）。
 * 结构错误抛错不落盘——编辑器宁可拒绝保存，也不把坏世界书留给下次开团。
 */
export async function writeRoomWorldBook(
  layout: DataLayout,
  roomId: string,
  book: WorldBook,
): Promise<WriteWorldBookResult> {
  const result = validateWorldBook({ entries: book.entries });
  if (!result.ok || result.book === null) {
    throw new Error(`世界书校验未通过：\n${result.errors.join('\n')}`);
  }
  await storeFor(layout, roomId).write({
    schemaVersion: SCHEMA_VERSION,
    entries: result.book.entries,
  });
  return { book: result.book, warnings: result.warnings };
}
