import type { FastifyInstance } from 'fastify';
import type {
  DirectiveTotals,
  GlobalMetricsSnapshot,
  MetricsCollector,
} from '../../observability/metrics.js';

/**
 * 可观测 REST 出口（T-M6-03，FR-13 / R-01 / R-02；TDD §9「指标」一行）。
 *
 * `GET /metrics` → 进程内全局指标 JSON：运行秒数、指令解析成功率、骰子总数、
 * LLM 调用（次数 / 失败 / 输入输出 token / 延迟分布 p50·p95·max·avg）。
 * 全部来自内存累计，**不读盘**——指标旁路不能反过来拖慢跑团主链路。
 *
 * 鉴权沿用管理面口径（决议 ②，与 rooms.ts / export.ts 同一把锁）：
 * AIDLE_ADMIN_TOKEN 设置后要求 `X-Admin-Token` 头，未设置则放行；拒绝码 E-ROOM-01。
 *
 * 房内 KP 控制台另走 Socket `kp:metrics`（会话级、仅 Host）——前端不带管理令牌，
 * 拿不到本端点，两边不是一回事。
 */

export interface MetricsRouteDeps {
  /** 与 rooms.ts 同源：undefined 表示管理面不启用门禁 */
  adminToken: string | undefined;
  /** 进程内指标收集器（装配根单例，与网关共用同一实例） */
  metrics: MetricsCollector;
  /**
   * R-01 指令解析成功率的**取数口**（GatewayHandle.directiveStats）。
   * 传函数而非快照：每请求现取，避免装配期固化成启动瞬间的旧值。
   * 统计本身在网关的 DirectiveSuccessTracker 里，本模块不重复造一套。
   */
  directives: () => DirectiveTotals;
}

interface ReplySender {
  send(payload: unknown): unknown;
}
interface ReplyLike {
  code(statusCode: number): ReplySender;
}

export function registerMetricsRoutes(app: FastifyInstance, deps: MetricsRouteDeps): void {
  const { adminToken, metrics, directives } = deps;

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

  app.get('/metrics', { preHandler: requireAdmin }, async (): Promise<GlobalMetricsSnapshot> => {
    return metrics.snapshot(directives());
  });
}
