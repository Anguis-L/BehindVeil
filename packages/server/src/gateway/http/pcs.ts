import { PCSheetSchema, readCardExtensions } from '@behindveil/shared';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { DataLayout } from '../../adapters/storage/layout.js';
import { readCard } from '../../domain/character/library.js';
import { readMembers } from '../../domain/session/members.js';
import { readRoomFile } from '../../domain/session/rooms.js';
import {
  declarePc,
  readRoomRoster,
  undeclarePc,
  type DeclaredPc,
} from '../../domain/stateboard/declare.js';

/**
 * PC 声明 REST（T-M5-04，FR-01/08，SDD §5.1 开团流程）。
 *
 * 声明收敛在 Host 侧（管理面口径，与 rooms.ts 管理组一致：X-Admin-Token 门禁）——
 * v1 的写权限哲学是 Host/引擎可写（TC-FR-09-003），玩家声明由 Host 代录：
 * 玩家导入卡到卡库或报数值，Host 绑定到成员。两条声明路径：
 * - { cardId }：从卡库读玩家卡，取 extensions.aidle.pcSheet（FR-08 导入卡进名册）；
 * - { sheet }：无卡速建表直填（SDD §5.1「填写速建表」）。
 *
 * 声明属开团前准备态（rooms/:id/roster.json），开团时由 createSession 装配进
 * 状态板初始 pcs；响应体统一 AppError 形状。
 */

const DeclarePcSchema = z
  .object({
    cardId: z.string().min(1).optional(),
    sheet: PCSheetSchema.optional(),
  })
  .refine((v) => (v.cardId !== undefined) !== (v.sheet !== undefined), {
    message: 'cardId 与 sheet 二选一',
  });

function firstIssueMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  const path = issue ? issue.path.join('.') : '';
  return issue ? `${path || '(根)'}: ${issue.message}` : '请求体不合法';
}

export interface PcRouteDeps {
  layout: DataLayout;
  /** 决议 ②：来自 AIDLE_ADMIN_TOKEN；undefined 表示管理面不启用门禁 */
  adminToken: string | undefined;
}

export function registerPcRoutes(app: FastifyInstance, deps: PcRouteDeps): void {
  const { layout, adminToken } = deps;

  const requireAdmin = async (
    req: { headers: Record<string, unknown> },
    reply: { code(statusCode: number): { send(payload: unknown): unknown } },
  ): Promise<unknown> => {
    if (adminToken === undefined) return undefined;
    if (req.headers['x-admin-token'] !== adminToken) {
      return reply.code(401).send({ code: 'E-ROOM-01', message: '管理面需要 X-Admin-Token 令牌' });
    }
    return undefined;
  };

  app.get('/rooms/:roomId/pcs', { preHandler: requireAdmin }, async (req, reply) => {
    const { roomId } = req.params as { roomId: string };
    if (!(await readRoomFile(layout, roomId))) {
      return reply.code(404).send({ code: 'E-ROOM-01', message: '房间不存在' });
    }
    const roster = await readRoomRoster(layout, roomId);
    return Object.entries(roster.pcs).map(([memberId, declared]) => ({ memberId, ...declared }));
  });

  app.put('/rooms/:roomId/pcs/:memberId', { preHandler: requireAdmin }, async (req, reply) => {
    const { roomId, memberId } = req.params as { roomId: string; memberId: string };
    const room = await readRoomFile(layout, roomId);
    if (!room) return reply.code(404).send({ code: 'E-ROOM-01', message: '房间不存在' });
    const members = await readMembers(layout, roomId);
    if (!members.some((m) => m.id === memberId)) {
      return reply.code(400).send({ code: 'E-ROOM-01', message: '成员不存在：先进房再声明 PC' });
    }
    const parsed = DeclarePcSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'E-ROOM-01', message: firstIssueMessage(parsed.error) });
    }

    let declared: DeclaredPc;
    if (parsed.data.cardId !== undefined) {
      const found = await readCard(layout, parsed.data.cardId);
      if (!found) {
        return reply.code(400).send({ code: 'E-CARD-01', message: '角色卡不存在' });
      }
      const sheet = readCardExtensions(found.card).pcSheet;
      if (!sheet) {
        return reply.code(400).send({
          code: 'E-CARD-01',
          message: '该卡不带 pcSheet（KP 卡或社区卡未扩展），不能声明为 PC',
        });
      }
      declared = { sheet, source: 'card', cardId: found.entry.id };
    } else {
      declared = { sheet: parsed.data.sheet as DeclaredPc['sheet'], source: 'manual' };
    }

    const roster = await declarePc(layout, roomId, memberId, declared);
    const saved = roster.pcs[memberId];
    return reply.code(201).send({ memberId, ...saved });
  });

  app.delete('/rooms/:roomId/pcs/:memberId', { preHandler: requireAdmin }, async (req, reply) => {
    const { roomId, memberId } = req.params as { roomId: string; memberId: string };
    if (!(await readRoomFile(layout, roomId))) {
      return reply.code(404).send({ code: 'E-ROOM-01', message: '房间不存在' });
    }
    if (!(await undeclarePc(layout, roomId, memberId))) {
      return reply.code(404).send({ code: 'E-ROOM-01', message: '该成员未声明 PC' });
    }
    return reply.code(204).send();
  });
}
