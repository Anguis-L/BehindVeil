import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MetricsCollector } from '../../observability/metrics.js';
import { registerMetricsRoutes } from './metrics.js';

/**
 * T-M6-03：`GET /metrics` 路由单测（FR-13 / R-01 / R-02）。
 * 只测出口两件事——鉴权口径与管理面一致、快照形状与网关取数口接通；
 * 数值本身由 observability/metrics.test.ts 钉死。
 */

const ADMIN_TOKEN = 'secret-metrics-123';

let metrics: MetricsCollector;
let app: FastifyInstance;
let secured: FastifyInstance;
/** 指令成功率的取数口：可切值以验证「每请求现取」而非装配期固化 */
let directives = { attempts: 0, successes: 0 };

beforeAll(async () => {
  metrics = new MetricsCollector();
  metrics.recordDice('s_1', false);
  metrics.recordDice('s_1', true);
  metrics.recordLlmCall('s_1', 120, { promptTokens: 6000, completionTokens: 1000 });
  metrics.recordLlmCall('s_1', 480, { promptTokens: 6000, completionTokens: 1000 });
  metrics.recordLlmFailure('s_1', 900);

  app = Fastify({ logger: false });
  registerMetricsRoutes(app, {
    adminToken: undefined,
    metrics,
    directives: () => directives,
  });
  await app.ready();

  secured = Fastify({ logger: false });
  registerMetricsRoutes(secured, {
    adminToken: ADMIN_TOKEN,
    metrics,
    directives: () => directives,
  });
  await secured.ready();
});

afterAll(async () => {
  await Promise.all([app.close(), secured.close()]);
});

interface MetricsBody {
  uptimeSec: number;
  directives: { attempts: number; successes: number; rate: number };
  dice: { total: number; hidden: number };
  llm: {
    calls: number;
    failures: number;
    tokensIn: number;
    tokensOut: number;
    latencyMs: { p50: number; p95: number; max: number; avg: number };
  };
}

describe('GET /metrics（T-M6-03）', () => {
  it('未设置 AIDLE_ADMIN_TOKEN 时放行（零配置，与 rooms.ts 同口径）', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
  });

  it('返回全局四类指标，形状与契约一致', async () => {
    directives = { attempts: 10, successes: 9 };
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    const body = res.json() as MetricsBody;

    expect(Object.keys(body).sort()).toEqual(['dice', 'directives', 'llm', 'uptimeSec']);
    expect(typeof body.uptimeSec).toBe('number');
    expect(body.directives).toEqual({ attempts: 10, successes: 9, rate: 0.9 });
    expect(body.dice).toEqual({ total: 2, hidden: 1 });
    expect(body.llm.calls).toBe(2);
    expect(body.llm.failures).toBe(1);
    expect(body.llm.tokensIn).toBe(12_000);
    expect(body.llm.tokensOut).toBe(2_000);
    // 样本 [120, 480, 900]
    expect(body.llm.latencyMs).toEqual({
      p50: 480,
      p95: 900,
      max: 900,
      avg: (120 + 480 + 900) / 3,
    });
  });

  it('指令成功率每次现取（装配期不固化）', async () => {
    directives = { attempts: 4, successes: 2 };
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect((res.json() as MetricsBody).directives).toEqual({
      attempts: 4,
      successes: 2,
      rate: 0.5,
    });
  });

  it('无指令尝试时 rate = 1（R-01 口径：尚无失败证据）', async () => {
    directives = { attempts: 0, successes: 0 };
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect((res.json() as MetricsBody).directives.rate).toBe(1);
  });

  it('设置令牌后：无令牌 / 错令牌 → 401（E-ROOM-01）', async () => {
    const denied = await secured.inject({ method: 'GET', url: '/metrics' });
    expect(denied.statusCode).toBe(401);
    expect(denied.json()).toMatchObject({ code: 'E-ROOM-01' });

    const wrong = await secured.inject({
      method: 'GET',
      url: '/metrics',
      headers: { 'x-admin-token': 'nope' },
    });
    expect(wrong.statusCode).toBe(401);
  });

  it('对令牌放行', async () => {
    const res = await secured.inject({
      method: 'GET',
      url: '/metrics',
      headers: { 'x-admin-token': ADMIN_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as MetricsBody).dice.total).toBe(2);
  });
});
