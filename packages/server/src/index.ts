import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { APP_NAME, PROTOCOL_VERSION } from '@behindveil/shared';
import { recover } from './adapters/storage/recovery.js';
import { loadConfig } from './config.js';
import { redact } from './observability/redact.js';

/**
 * 服务端组装根（T-M0-11）。
 *
 * 结构见 TDD §1.2：gateway/（M1）· domain/ · pipeline/ · adapters/ · observability/。
 * 唯一不变式：叙事交给 LLM，规则交给代码——任何掷骰都在此进程内用 CSPRNG 完成。
 */
export const serverInfo = {
  name: `${APP_NAME}-server`,
  protocol: PROTOCOL_VERSION,
} as const;

export interface CreateServerOptions {
  /** data/ 目录（默认 <cwd>/data） */
  dataDir?: string;
  /** 覆盖 config.yaml 的监听地址 / 端口 */
  host?: string;
  port?: number;
  /** Fastify logger 选项（默认开启） */
  logger?: boolean;
  /** web SPA 产物目录；不存在则跳过静态托管 */
  webDistDir?: string;
}

export async function createServer(opts: CreateServerOptions = {}): Promise<FastifyInstance> {
  const dataDir = resolve(opts.dataDir ?? join(process.cwd(), 'data'));
  const cfg = loadConfig({ dataDir });
  const app = Fastify({ logger: opts.logger ?? true });

  // NFR-03：任何错误出口（消息/堆栈）经 redact 后再写日志，防 key 泄露
  app.setErrorHandler<FastifyError>((err, _req, reply) => {
    app.log.error({ err: redact(err, [cfg.llm.apiKey]) }, '请求处理失败');
    const status = typeof err.statusCode === 'number' ? err.statusCode : 500;
    void reply.status(status).send({
      code: 'INTERNAL',
      message: status >= 500 ? '内部错误，详情见服务端日志' : err.message,
    });
  });

  // 启动恢复（TDD §6 / SDD §5.3）：坏行告警不阻断启动
  const report = await recover(dataDir);
  const recoveredMessages = report.sessions.reduce((sum, s) => sum + s.messageCount, 0);
  app.log.info(
    { rooms: report.rooms.length, sessions: report.sessions.length, messages: recoveredMessages },
    '启动恢复完成',
  );
  for (const warning of report.warnings) app.log.warn(warning);

  app.get('/healthz', async () => ({
    ok: true,
    name: serverInfo.name,
    protocol: PROTOCOL_VERSION,
  }));

  const webDistDir =
    opts.webDistDir ?? resolve(fileURLToPath(new URL('../../web/dist', import.meta.url)));
  if (existsSync(webDistDir)) {
    await app.register(fastifyStatic, { root: webDistDir });
  } else {
    app.log.warn(`未找到 web 前端产物（${webDistDir}），跳过静态托管`);
  }

  return app;
}

/** CLI 启动入口：装载配置 → 建服 → 监听 → 优雅退出 */
export async function start(opts: CreateServerOptions = {}): Promise<void> {
  const dataDir = resolve(opts.dataDir ?? join(process.cwd(), 'data'));
  const cfg = loadConfig({ dataDir });
  const app = await createServer(opts);
  await app.listen({ host: opts.host ?? cfg.host, port: opts.port ?? cfg.port });

  const shutdown = (signal: string): void => {
    app.log.info({ signal }, '收到退出信号，关闭服务');
    void app.close();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

// 直接 `node dist/index.js` 运行时启动；被测试/其他模块 import 时不自动拉起
const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  start().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
