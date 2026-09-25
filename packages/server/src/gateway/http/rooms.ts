import { SessionSettingsSchema, type Message, type Room, type Session } from '@behindveil/shared';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { DataLayout } from '../../adapters/storage/layout.js';
import {
  createRoom,
  listRoomFiles,
  readRoomFile,
  resetInviteCode,
  toPublicRoom,
  updateRoomSettings,
} from '../../domain/session/rooms.js';
import { listSessions, endSession, setActiveSession } from '../../domain/session/sessions.js';
import { readMessagesPage } from '../../domain/session/messages.js';

/**
 * 管理面 REST（T-M1-02/09，决议 D-03 + docs/openapi.yaml + 2026-09-25 四项拍板）。
 *
 * 鉴权（决议 ②）：环境变量 AIDLE_ADMIN_TOKEN 设置后，除 /healthz 外的全部管理接口
 * 必须携带 `X-Admin-Token` 头（缺失/错误 → 401）；未设置则不启用（零配置，依托网络边界）。
 * hostToken（决议 ①）只随建房响应下发一次、进房时证明 Host 身份，不参与管理面鉴权，
 * 且任何其他响应不得回带。
 * 响应体统一 AppError 形状 { code, message }。
 */

export interface RestDeps {
  layout: DataLayout;
  /** 决议 ②：来自 AIDLE_ADMIN_TOKEN；undefined 表示管理面不启用门禁 */
  adminToken: string | undefined;
}

const CreateRoomSchema = z.object({
  name: z.string().min(1).max(50),
  memberLimit: z.number().int().min(2).max(64).optional(),
  defaultSessionSettings: SessionSettingsSchema.optional(),
});

const SettingsPatchSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  memberLimit: z.number().int().min(2).max(64).optional(),
  defaultSessionSettings: SessionSettingsSchema.optional(),
});

const ActiveSessionSchema = z.object({ sessionId: z.string().min(1) });

function firstIssueMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  const path = issue ? issue.path.join('.') : '';
  return issue ? `${path || '(根)'}: ${issue.message}` : '请求体不合法';
}

export function registerRoomRoutes(app: FastifyInstance, deps: RestDeps): void {
  const { layout, adminToken } = deps;

  // 决议 ②：AIDLE_ADMIN_TOKEN 设置时，除 /healthz 外的全部管理接口要求 X-Admin-Token
  const requireAdmin = async (
    req: { headers: Record<string, unknown> },
    reply: {
      code(statusCode: number): { send(payload: unknown): unknown };
    },
  ): Promise<unknown> => {
    if (adminToken === undefined) return undefined;
    if (req.headers['x-admin-token'] !== adminToken) {
      return reply.code(401).send({ code: 'E-ROOM-01', message: '管理面需要 X-Admin-Token 令牌' });
    }
    return undefined;
  };

  app.post('/rooms', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = CreateRoomSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'E-ROOM-01', message: firstIssueMessage(parsed.error) });
    }
    const room = await createRoom(layout, parsed.data);
    // 决议 ①：hostToken 仅此一次下发
    return reply.code(201).send({ ...toPublicRoom(room), hostToken: room.hostToken });
  });

  app.get('/rooms', { preHandler: requireAdmin }, async () => {
    const files = await listRoomFiles(layout);
    const rooms: Room[] = files.map(toPublicRoom);
    return rooms;
  });

  app.get('/rooms/:roomId', { preHandler: requireAdmin }, async (req, reply) => {
    const { roomId } = req.params as { roomId: string };
    const room = await readRoomFile(layout, roomId);
    if (!room) {
      return reply.code(404).send({ code: 'E-ROOM-01', message: '房间不存在' });
    }
    return toPublicRoom(room);
  });

  app.post('/rooms/:roomId/invite-reset', { preHandler: requireAdmin }, async (req, reply) => {
    const { roomId } = req.params as { roomId: string };
    const room = await readRoomFile(layout, roomId);
    if (!room) return reply.code(404).send({ code: 'E-ROOM-01', message: '房间不存在' });
    const inviteCode = await resetInviteCode(layout, roomId);
    return { inviteCode };
  });

  app.patch('/rooms/:roomId/settings', { preHandler: requireAdmin }, async (req, reply) => {
    const { roomId } = req.params as { roomId: string };
    const parsed = SettingsPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'E-ROOM-01', message: firstIssueMessage(parsed.error) });
    }
    const updated = await updateRoomSettings(layout, roomId, parsed.data);
    if (!updated) return reply.code(404).send({ code: 'E-ROOM-01', message: '房间不存在' });
    return toPublicRoom(updated);
  });

  app.get('/rooms/:roomId/sessions', { preHandler: requireAdmin }, async (req, reply) => {
    const { roomId } = req.params as { roomId: string };
    const room = await readRoomFile(layout, roomId);
    if (!room) return reply.code(404).send({ code: 'E-ROOM-01', message: '房间不存在' });
    const sessions: Session[] = await listSessions(layout, roomId);
    return sessions;
  });

  // 历史拉取（决议 ④：走 REST，T-M1-09；与 Socket 补发互补——
  // 断线重连的缺口走 room:join 的 lastSeq 补发，本接口用于主动翻历史）
  app.get('/rooms/:roomId/messages', { preHandler: requireAdmin }, async (req, reply) => {
    const { roomId } = req.params as { roomId: string };
    const query = req.query as { sessionId?: string; beforeSeq?: string; limit?: string };
    const beforeSeq = query.beforeSeq !== undefined ? Number(query.beforeSeq) : undefined;
    const limit = query.limit !== undefined ? Number(query.limit) : undefined;
    if (
      (beforeSeq !== undefined && (!Number.isInteger(beforeSeq) || beforeSeq < 0)) ||
      (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200))
    ) {
      return reply.code(400).send({ code: 'E-ROOM-01', message: 'beforeSeq/limit 不合法' });
    }
    const room = await readRoomFile(layout, roomId);
    if (!room) return reply.code(404).send({ code: 'E-ROOM-01', message: '房间不存在' });
    const sessionId = query.sessionId ?? room.activeSessionId;
    if (!sessionId) return []; // 尚未开团：空历史
    const page = await readMessagesPage(layout, roomId, sessionId, {
      beforeSeq,
      limit: limit ?? 50,
      excludeHidden: true,
    });
    const messages: Message[] = page.messages;
    return messages;
  });

  // 会话结束（T-M1-07；openapi 未列出，属提案端点，待契约文档回补）
  app.post(
    '/rooms/:roomId/sessions/:sessionId/end',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { roomId, sessionId } = req.params as { roomId: string; sessionId: string };
      const session = await endSession(layout, roomId, sessionId);
      if (!session) return reply.code(404).send({ code: 'E-ROOM-01', message: '会话不存在' });
      return session;
    },
  );

  // 活跃会话切换（T-M1-07，FR-11 连载复播；提案端点）
  app.put('/rooms/:roomId/active-session', { preHandler: requireAdmin }, async (req, reply) => {
    const { roomId } = req.params as { roomId: string };
    const parsed = ActiveSessionSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'E-ROOM-01', message: firstIssueMessage(parsed.error) });
    }
    const session = await setActiveSession(layout, roomId, parsed.data.sessionId);
    if (!session) return reply.code(404).send({ code: 'E-ROOM-01', message: '会话不存在' });
    return session;
  });
}
