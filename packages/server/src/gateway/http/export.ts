import type { FastifyInstance } from 'fastify';
import type { DataLayout } from '../../adapters/storage/layout.js';
import { renderHtml } from '../../adapters/export/html.js';
import { renderMarkdown } from '../../adapters/export/markdown.js';
import type { ExportInput } from '../../adapters/export/render.js';
import { readMembers } from '../../domain/session/members.js';
import { readMessagesAfter } from '../../domain/session/messages.js';
import { readRoomFile } from '../../domain/session/rooms.js';
import { readSession } from '../../domain/session/sessions.js';

/**
 * 日志导出 REST（T-M6-01/02，FR-12；SDD §3.2 M8 行）。
 *
 * `GET /rooms/:roomId/sessions/:sessionId/export?format=md|html`
 *
 * 鉴权沿用管理面口径（决议 ②，AIDLE_ADMIN_TOKEN / X-Admin-Token）：导出是 Host 视角
 * **完整版**——暗骰、仅 Host 可见的场外消息一律照实导出（隐藏的是广播范围，不是凭据），
 * 因此出口必须与建房/房间列表同级保护，不能挂在普通成员可及的路径上。
 *
 * 只读，不落盘：产物直接随响应返回，由浏览器/下载工具保存。
 */

export type ExportFormat = 'markdown' | 'html';

export interface ExportRouteDeps {
  layout: DataLayout;
  /** 与 rooms.ts 同源：undefined 表示管理面不启用门禁 */
  adminToken: string | undefined;
}

interface ReplySender {
  send(payload: unknown): unknown;
}
interface ReplyLike {
  code(statusCode: number): ReplySender;
  /** 返回 reply 自身以便链式调用 */
  header(key: string, value: string): ReplyLike;
  type(mime: string): ReplySender;
  send(payload: unknown): unknown;
}

function parseFormat(raw: unknown): ExportFormat | null {
  if (raw === undefined || raw === 'md' || raw === 'markdown') return 'markdown';
  if (raw === 'html') return 'html';
  return null;
}

export function registerExportRoutes(app: FastifyInstance, deps: ExportRouteDeps): void {
  const { layout, adminToken } = deps;

  const requireAdmin = async (
    req: { headers: Record<string, unknown> },
    reply: ReplyLike,
  ): Promise<unknown> => {
    if (adminToken === undefined) return undefined;
    if (req.headers['x-admin-token'] !== adminToken) {
      return reply.code(401).send({ code: 'E-ROOM-01', message: '管理面需要 X-Admin-Token 令牌' });
    }
    return undefined;
  };

  app.get(
    '/rooms/:roomId/sessions/:sessionId/export',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { roomId, sessionId } = req.params as { roomId: string; sessionId: string };
      const typedReply = reply as unknown as ReplyLike;

      const format = parseFormat((req.query as { format?: string }).format);
      if (format === null) {
        return typedReply
          .code(400)
          .send({ code: 'E-ROOM-01', message: 'format 仅支持 md 或 html' });
      }

      const room = await readRoomFile(layout, roomId);
      if (!room) {
        return typedReply.code(404).send({ code: 'E-ROOM-01', message: '房间不存在' });
      }
      const session = await readSession(layout, roomId, sessionId);
      if (!session) {
        return typedReply.code(404).send({ code: 'E-ROOM-01', message: '会话不存在' });
      }

      // viewer=null：导出是管理工具场景（消息仓库对该语义的显式约定），按 seq 升序取全量
      const messages = await readMessagesAfter(layout, roomId, sessionId, -1, null);
      const members = await readMembers(layout, roomId);
      const input: ExportInput = { roomName: room.name, session, members, messages };

      const body = format === 'html' ? renderHtml(input) : renderMarkdown(input);
      const ext = format === 'html' ? 'html' : 'md';
      const mime = format === 'html' ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8';
      const stamp = session.startedAt.slice(0, 10);

      typedReply.header(
        'Content-Disposition',
        `attachment; filename="behindveil-${roomId}-${sessionId}-${stamp}.${ext}"`,
      );
      return typedReply.type(mime).send(body);
    },
  );
}
