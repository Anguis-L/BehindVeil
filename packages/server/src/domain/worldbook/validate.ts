import { WorldBookSchema, type WorldBook } from '@behindveil/shared';
import { readFile } from 'node:fs/promises';
import type { DataLayout } from '../../adapters/storage/layout.js';

/**
 * 世界书载入校验器（T-M2-06，决议 D-08）。
 *
 * v1 无可视化编辑器：世界书 JSON 手编 + 载入校验（防范围蔓延）。
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
 */
export async function loadWorldBook(
  layout: DataLayout,
  roomId: string,
): Promise<WorldBookLoadResult> {
  let text: string;
  try {
    text = await readFile(layout.worldbookFile(roomId), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { book: { entries: [] }, warnings: [] };
    }
    throw new Error(`世界书读取失败：${err instanceof Error ? err.message : String(err)}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`世界书 JSON 解析失败：${err instanceof Error ? err.message : String(err)}`);
  }

  const result = validateWorldBook(raw);
  if (!result.ok || result.book === null) {
    throw new Error(`世界书校验未通过：\n${result.errors.join('\n')}`);
  }
  return { book: result.book, warnings: result.warnings };
}

function isRegexForm(keyword: string): boolean {
  return keyword.length > 2 && keyword.startsWith('/') && keyword.endsWith('/');
}
