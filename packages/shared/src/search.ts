import { z } from 'zod';
import { MESSAGE_TYPES } from './message.js';

/**
 * 跨房间检索契约（v3 T-M11-05，FR-34，设计 §5.3）。
 *
 * 前后端共用一份：**索引行长什么样**是 REST `GET /search` 的响应契约，
 * 服务端写、前端读，Schema 必须在 shared 落地（契约先行，与 protocol.ts 同一纪律）。
 *
 * 索引行是 Host 视角完整版（含暗骰行）——它不是消息投递通道，
 * 前端拿到后只做展示，不做任何可见性过滤（过滤是消息流的职责，两套口径不混用）。
 */

export const GlobalIndexEntrySchema = z.object({
  roomId: z.string(),
  sessionId: z.string(),
  seq: z.number().int().nonnegative(),
  type: z.enum(MESSAGE_TYPES),
  /** 系统消息为空串（无发送者）；dice 缺省为引擎代掷 */
  senderId: z.string(),
  /** ISO8601 */
  ts: z.string(),
  /** 仅 dice 消息可能有：暗骰标记 */
  hidden: z.boolean().optional(),
  /** 可检索文本：ic/ooc/system/narration 取正文；dice 取「骰式 = 结果」；快照为空串 */
  content: z.string(),
});
export type GlobalIndexEntry = z.infer<typeof GlobalIndexEntrySchema>;

export const SearchResponseSchema = z.object({
  /** 回显查询词（前端防竞态：响应回来时输入框可能已经变了） */
  query: z.string(),
  hits: z.array(GlobalIndexEntrySchema),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;
