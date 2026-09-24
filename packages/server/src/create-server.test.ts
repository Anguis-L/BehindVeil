import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@behindveil/shared';
import type { CreateServerOptions } from './index.js';
import { createServer, serverInfo } from './index.js';

/**
 * T-M0-11：组装根（Fastify + healthcheck + 静态托管 + 启动恢复）。
 * 单独成文是为了不与 index.test.ts（占位契约测试）争用同一文件。
 */

const created: string[] = [];
const apps: FastifyInstance[] = [];

async function makeDataDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'bv-server-'));
  created.push(dir);
  return dir;
}

async function build(opts: CreateServerOptions & { dataDir: string }): Promise<FastifyInstance> {
  const app = await createServer({ ...opts, logger: false });
  apps.push(app);
  await app.ready();
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('healthcheck', () => {
  it('/healthz 返回服务名与协议版本', async () => {
    const app = await build({ dataDir: await makeDataDir() });

    const res = await app.inject({ method: 'GET', url: '/healthz' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      name: serverInfo.name,
      protocol: PROTOCOL_VERSION,
    });
  });
});

describe('启动恢复（TDD §6 / NFR-06）', () => {
  it('data 目录缺失时不阻断启动（首次部署）', async () => {
    const dataDir = await makeDataDir();
    const app = await build({ dataDir: path.join(dataDir, 'no-such') });

    const res = await app.inject({ method: 'GET', url: '/healthz' });

    expect(res.statusCode).toBe(200);
  });

  it('JSONL 坏行不阻断启动，服务可正常响应', async () => {
    const dataDir = await makeDataDir();
    const roomDir = path.join(dataDir, 'rooms', 'room_1', 'sessions', 'ses_1');
    await mkdir(roomDir, { recursive: true });
    await writeFile(path.join(roomDir, 'messages.jsonl'), '{"seq":1}\n{"seq":2\nGARBAGE\n', 'utf8');

    const app = await build({ dataDir });

    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });
});

describe('web 静态托管', () => {
  it('产物目录存在时托管 SPA', async () => {
    const webDistDir = fileURLToPath(new URL('../../web/dist', import.meta.url));
    const app = await build({ dataDir: await makeDataDir(), webDistDir });

    const res = await app.inject({ method: 'GET', url: '/' });

    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain('html');
  });

  it('产物目录不存在时跳过托管且不报错', async () => {
    const app = await build({ dataDir: await makeDataDir() });

    const res = await app.inject({ method: 'GET', url: '/healthz' });

    expect(res.statusCode).toBe(200);
  });
});
