import type { FastifyInstance } from 'fastify';
import { GlobalIndex, type GlobalIndexEntry } from '../../observability/global-index.js';
import type { DataLayout } from '../../adapters/storage/layout.js';

/**
 * 跨房间检索出口（v3 T-M11-05，FR-34，设计 §5.3）。
 *
 * `GET /search?q=<关键词>&roomId=&limit=` → 全局索引命中行（seq 降序）。
 * 索引是**管理面数据**（Host 视角完整版，含暗骰行），与 `GET /metrics` 同一信任级别：
 * 设了 AIDLE_ADMIN_TOKEN 就要 X-Admin-Token。玩家侧要翻历史走既有的
 * `GET /rooms/:id/messages`（已按身份剔除暗骰/密语），本端点不做玩家可见性过滤——
 * 它的用途是「KP 事后找某句话发生在哪个团」，不是消息投递通道。
 *
 * 只读：索引文件由网关追加、`aidle-reindex` 重建，本路由永不写。
 */

export interface SearchRouteDeps {
  layout: DataLayout;
  /** undefined 表示管理面不启用门禁（与 rooms.ts / metrics.ts 同一把锁） */
  adminToken: string | undefined;
}

interface ReplySender {
  send(payload: unknown): unknown;
}
interface ReplyLike {
  code(statusCode: number): ReplySender;
}

export interface SearchResponse {
  query: string;
  hits: GlobalIndexEntry[];
}

/** 单页上限：索引是事后翻查工具，一次给太多没意义（默认 50 在索引层兜底） */
const MAX_LIMIT = 200;

export function registerSearchRoutes(app: FastifyInstance, deps: SearchRouteDeps): void {
  const { layout, adminToken } = deps;
  const index = new GlobalIndex(layout.globalIndexFile);

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

  app.get('/search', { preHandler: requireAdmin }, async (req): Promise<SearchResponse> => {
    const query = (req as { query: Record<string, unknown> }).query;
    const q = typeof query['q'] === 'string' ? query['q'] : '';
    if (q.trim() === '') {
      return { query: q, hits: [] };
    }
    const roomId = typeof query['roomId'] === 'string' ? query['roomId'] : undefined;
    const rawLimit = Number(query['limit']);
    const limit =
      Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : undefined;

    const hits = await index.search(q, {
      ...(roomId ? { roomId } : {}),
      ...(limit ? { limit } : {}),
    });
    return { query: q, hits };
  });
}
