import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { LlmRuntime } from '../../adapters/llm/runtime.js';

/**
 * LLM 运行时配置 REST（2026-10-08 可用性改造）。
 *
 * 换模型的入口从「手改 config.yaml + 重启」搬到页面：`GET /llm` 看当前接的是谁、
 * `PATCH /llm` 热更（下一次 AI 调用即生效）、`POST /llm/test` 连通性自检。
 * 鉴权沿用管理面口径（X-Admin-Token；未设令牌 = 零配置开放，与既有路由一致）。
 *
 * 安全口径（NFR-03）：响应**永不回传明文 key**，只给 `hasApiKey` / `apiKeyHint`；
 * 运行时改的 key 只活在内存在，重启后回落到 config.yaml + AIDLE_LLM_KEY。
 */

const FieldsSchema = z.object({
  provider: z.string().min(1).max(60).optional(),
  model: z.string().max(200).optional(),
  /** 空串表示「不填」（如 ollama 走默认端点） */
  baseUrl: z.string().max(500).optional(),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
  maxTokens: z.number().int().positive().max(200_000).optional(),
  /** 空串 = 清除已填的密钥 */
  apiKey: z.string().max(500).optional(),
});

const PatchSchema = FieldsSchema.refine((v) => Object.keys(v).length > 0, {
  message: '至少提供一项要修改的配置',
});

/** 自检可带一份临时配置（不落库）：填完先试、通了再保存 */
const TestSchema = FieldsSchema.optional();

export interface LlmConfigRouteDeps {
  runtime: LlmRuntime;
  /** 决议 ②：来自 AIDLE_ADMIN_TOKEN；undefined 表示管理面不启用门禁 */
  adminToken: string | undefined;
  /**
   * 热更生效回调：把新适配器与 chat 参数推进已在运行的网关（装配根注入）。
   * 不传 = 只改配置不通知（单测装配 runtime 时用得上）。
   */
  onChange?: () => void;
}

function firstIssueMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  const path = issue ? issue.path.join('.') : '';
  return issue ? `${path || '(根)'}: ${issue.message}` : '请求体不合法';
}

export function registerLlmConfigRoutes(app: FastifyInstance, deps: LlmConfigRouteDeps): void {
  const { runtime, adminToken, onChange } = deps;

  const requireAdmin = async (
    req: { headers: Record<string, unknown> },
    reply: { code(statusCode: number): { send(payload: unknown): unknown } },
  ): Promise<unknown> => {
    if (adminToken === undefined) return undefined;
    if (req.headers['x-admin-token'] !== adminToken) {
      return reply.code(401).send({ code: 'E-LLM-01', message: '管理面需要 X-Admin-Token 令牌' });
    }
    return undefined;
  };

  app.get('/llm', { preHandler: requireAdmin }, async () => runtime.snapshot());

  app.patch('/llm', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = PatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ code: 'E-LLM-01', message: firstIssueMessage(parsed.error) });
    }
    const result = runtime.patch(parsed.data);
    if (!result.ok) {
      // locked（测试注入）与「新配置不可用」都走 400：前者是拒绝修改，后者是校验失败
      return reply.code(400).send({ code: 'E-LLM-01', message: result.message });
    }
    onChange?.();
    return result.snapshot;
  });

  app.post('/llm/test', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = TestSchema.safeParse(req.body ?? undefined);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'E-LLM-01', message: firstIssueMessage(parsed.error) });
    }
    // 保护性拦截：没模型名就发探活，多数 provider 只会回一个无意义的 400
    const snapshot = runtime.snapshot();
    const model = parsed.data?.model ?? snapshot.model;
    if (model === '') {
      return reply.code(400).send({ code: 'E-LLM-01', message: '请先填写模型名，再点测试连接' });
    }
    // 探活失败也回 200：不通是「配置问题」不是「请求错误」，前端要显示原因而不是抛异常
    return await runtime.test(parsed.data);
  });
}
