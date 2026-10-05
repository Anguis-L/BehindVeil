import { WorldBookSchema, type WorldBook } from '@behindveil/shared';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { DataLayout } from '../../adapters/storage/layout.js';
import { loadModule } from '../../domain/module/library.js';
import { readRoomWorldBook, writeRoomWorldBook } from '../../domain/worldbook/store.js';

/**
 * 世界书编辑器 REST（v3 T-M11-06，FR-35，设计 §5.3）。
 *
 * 两条截然不同的权限边界，路由上物理分开：
 * - **房间层 RW**：`GET/PUT /rooms/:roomId/worldbook`——编辑器唯一写入口，
 *   保存前一律 `validateWorldBook`（D-08：结构错误拒绝落盘，语义隐患告警放行）；
 * - **模组层只读**：`GET /modules/:moduleId/worldbook`——模组包是外部资产，
 *   不提供写接口；要改就由前端「复制到房间层」再编辑（复制=普通 PUT，无新增语义）。
 *
 * 鉴权沿用管理面口径（X-Admin-Token）：世界书含模组真相（kpOnly 条目），
 * 与房间配置同级别。
 */

const PutWorldBookSchema = z.object({
  entries: WorldBookSchema.shape.entries,
});

interface ReplySender {
  send(payload: unknown): unknown;
}
interface ReplyLike {
  code(statusCode: number): ReplySender;
}

export interface WorldBookRouteDeps {
  layout: DataLayout;
  adminToken: string | undefined;
}

export interface WorldBookResponse {
  entries: WorldBook['entries'];
  /** 语义隐患（不阻断保存，编辑器原样展示给 KP） */
  warnings: string[];
}

export function registerWorldBookRoutes(app: FastifyInstance, deps: WorldBookRouteDeps): void {
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
    '/rooms/:roomId/worldbook',
    { preHandler: requireAdmin },
    async (req): Promise<WorldBookResponse> => {
      const { roomId } = req.params as { roomId: string };
      const { book, warnings } = await readRoomWorldBook(layout, roomId);
      return { entries: book.entries, warnings };
    },
  );

  app.put(
    '/rooms/:roomId/worldbook',
    { preHandler: requireAdmin },
    async (req, reply): Promise<WorldBookResponse | unknown> => {
      const { roomId } = req.params as { roomId: string };
      const parsed = PutWorldBookSchema.safeParse(req.body);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return reply.code(400).send({
          code: 'E-ROOM-01',
          message: `世界书结构不合法（${issue ? issue.path.join('.') || '(根)' : '(根)'}：${
            issue?.message ?? ''
          }）`,
        });
      }
      try {
        const result = await writeRoomWorldBook(layout, roomId, parsed.data);
        return { entries: result.book.entries, warnings: result.warnings };
      } catch (err) {
        // 校验未通过（uid 重复 / at_depth 缺 depth 等）→ 400，带上定位信息；
        // 落盘 IO 失败 → 500（交由全局错误处理器）
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ code: 'E-ROOM-01', message });
      }
    },
  );

  /** 模组层世界书只读：模组包内资产，改动请复制到房间层 */
  app.get(
    '/modules/:moduleId/worldbook',
    { preHandler: requireAdmin },
    async (req, reply): Promise<WorldBookResponse | unknown> => {
      const { moduleId } = req.params as { moduleId: string };
      const loaded = await loadModule(layout, moduleId);
      if (!loaded.ok) {
        return reply.code(404).send({ code: 'E-MOD-01', message: loaded.message });
      }
      return { entries: loaded.module.worldBook.entries, warnings: [] };
    },
  );
}
