import { WorldBookSchema, type WorldBook } from '@behindveil/shared';
import type { DataLayout } from '../../adapters/storage/layout.js';
import { readRoomWorldBook } from './store.js';

/**
 * 世界书载入校验器（T-M2-06，决议 D-08）。
 *
 * v1 无可视化编辑器：世界书 JSON 手编 + 载入校验（防范围蔓延）；
 * v3 T-M11-06 编辑器落地，写路径收编进 store.ts（带 schemaVersion 信封）。
 * - 结构错误（Schema 不符 / uid 重复 / at_depth 缺 depth）→ 拒绝载入，抛错带定位；
 * - 语义隐患（非法正则、非常驻条目空 key）→ 告警放行（运行时容错与扫描降级一致）。
 */

export interface WorldBookValidation {
  ok: boolean;
  book: WorldBook | null;
  errors: string[];
  warnings: string[];
}

export function validateWorldBook(raw: unknown): WorldBookValidation {
  const parsed = WorldBookSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      book: null,
      errors: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      warnings: [],
    };
  }

  const book = parsed.data;
  const errors: string[] = [];
  const warnings: string[] = [];

  const seenUids = new Set<number>();
  for (const entry of book.entries) {
    const at = `uid=${entry.uid}`;
    if (seenUids.has(entry.uid)) {
      errors.push(`${at}: uid 重复（uid 是 trace 与递归去重的键）`);
    }
    seenUids.add(entry.uid);

    if (entry.position === 'at_depth' && entry.depth === undefined) {
      errors.push(`${at}: position=at_depth 必须提供 depth`);
    }
    if (!entry.constant && entry.extensions?.kpOnly !== true && entry.key.length === 0) {
      warnings.push(`${at}: 非常驻条目 key 为空，永远不会命中`);
    }
    for (const keyword of [...entry.key, ...entry.keysecondary]) {
      // 空串关键词在 includes 语义下会无条件命中，扫描层将其忽略——载入时提醒手编者
      if (keyword.trim() === '') {
        warnings.push(`${at}: 存在空白关键词，扫描时将被忽略`);
        continue;
      }
      if (!isRegexForm(keyword)) continue;
      try {
        new RegExp(keyword.slice(1, -1));
      } catch (err) {
        warnings.push(
          `${at}: 非法正则关键词 "${keyword}"，扫描时将降级为字面量（${err instanceof Error ? err.message : String(err)}）`,
        );
      }
    }
  }

  return { ok: errors.length === 0, book, errors, warnings };
}

export interface WorldBookLoadResult {
  book: WorldBook;
  warnings: string[];
}

/**
 * 载入房间级手编世界书 `data/rooms/<roomId>/worldbook.json`。
 * 文件不存在 → 空 WorldBook（手编可选）；JSON 坏或结构错误 → 抛错（载入时拦截）。
 *
 * T-M11-06 起委托 store.ts（编辑器写路径与管线读路径共用同一口径，含版本迁移），
 * 保留本导出是为了不动既有调用点。
 */
export async function loadWorldBook(
  layout: DataLayout,
  roomId: string,
): Promise<WorldBookLoadResult> {
  return readRoomWorldBook(layout, roomId);
}

function isRegexForm(keyword: string): boolean {
  return keyword.length > 2 && keyword.startsWith('/') && keyword.endsWith('/');
}
