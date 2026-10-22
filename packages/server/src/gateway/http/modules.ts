import { ModuleInfoSchema, type ModuleInfo } from '@behindveil/shared';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { DataLayout } from '../../adapters/storage/layout.js';
import {
  findSampleModulesDir,
  installSampleModules,
  loadModule,
  listModules,
  unloadModule,
} from '../../domain/module/library.js';

/**
 * 模组管理 REST（T-M5-05，FR-10 / TDD §3.6，docs/openapi.yaml /modules 提案）。
 *
 * 文件系统即真相：「装载」= 对 `data/modules/<moduleId>/`（本机放置场景）执行
 * manifest + 三件套校验（TC-FR-10-001），校验失败即拒绝、不动盘；「卸载」按 D-09，
 * 活跃会话引用中回 409 + E-MOD-01。鉴权沿用管理面口径（决议 ②，X-Admin-Token）。
 *
 * 与 openapi 提案的偏差（回写时对齐）：装载请求走 { moduleId }（相对 modulesDir 的
 * 目录名）而非 multipart zip——模组包是目录形态，v1 不引入解压依赖；请求体直接给
 * 服务端本地已放置的目录名即可完成装载校验。
 */

const LoadModuleSchema = z.object({
  moduleId: z.string().min(1).max(120),
});

function firstIssueMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  const path = issue ? issue.path.join('.') : '';
  return issue ? `${path || '(根)'}: ${issue.message}` : '请求体不合法';
}

export interface ModuleRouteDeps {
  layout: DataLayout;
  /** 决议 ②：来自 AIDLE_ADMIN_TOKEN；undefined 表示管理面不启用门禁 */
  adminToken: string | undefined;
}

export function registerModuleRoutes(app: FastifyInstance, deps: ModuleRouteDeps): void {
  const { layout, adminToken } = deps;

  const requireAdmin = async (
    req: { headers: Record<string, unknown> },
    reply: { code(statusCode: number): { send(payload: unknown): unknown } },
  ): Promise<unknown> => {
    if (adminToken === undefined) return undefined;
    if (req.headers['x-admin-token'] !== adminToken) {
      return reply.code(401).send({ code: 'E-MOD-01', message: '管理面需要 X-Admin-Token 令牌' });
    }
    return undefined;
  };

  app.get('/modules', { preHandler: requireAdmin }, async () => {
    const modules: ModuleInfo[] = await listModules(layout);
    return modules;
  });

  /**
   * 内置示例剧本（2026-10-08 可用性改造）：`GET /modules` 空态时页面给一键装载，
   * 免得用户为「从哪弄一个剧本」去翻文档。幂等；示例源缺失时回 404 并给明话。
   */
  app.get('/modules/samples', { preHandler: requireAdmin }, async (_req, reply) => {
    if (findSampleModulesDir() === undefined) {
      return reply.code(404).send({ code: 'E-MOD-01', message: '本机没有内置示例剧本' });
    }
    return { available: true };
  });

  app.post('/modules/samples', { preHandler: requireAdmin }, async (_req, reply) => {
    const result = await installSampleModules(layout);
    if (!result.ok) {
      return reply.code(404).send({ code: 'E-MOD-01', message: result.message });
    }
    return reply.code(201).send(result.modules);
  });

  app.post('/modules', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = LoadModuleSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'E-MOD-01', message: firstIssueMessage(parsed.error) });
    }
    const loaded = await loadModule(layout, parsed.data.moduleId);
    if (!loaded.ok) {
      return reply.code(400).send({ code: 'E-MOD-01', message: `模组装载失败：${loaded.message}` });
    }
    const { manifest } = loaded.module;
    const info: ModuleInfo = ModuleInfoSchema.parse({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      rulebook: manifest.rulebook,
      apiVersion: manifest.apiVersion,
      activeSessions: 0, // 刚通过校验的装载动作不改变引用计数
    });
    return reply.code(201).send(info);
  });

  app.delete('/modules/:moduleId', { preHandler: requireAdmin }, async (req, reply) => {
    const { moduleId } = req.params as { moduleId: string };
    const result = await unloadModule(layout, moduleId);
    if (!result.ok) {
      if (result.reason === 'in-use') {
        return reply.code(409).send({ code: 'E-MOD-01', message: result.message });
      }
      return reply.code(404).send({ code: 'E-MOD-01', message: result.message });
    }
    return reply.code(204).send();
  });
}
