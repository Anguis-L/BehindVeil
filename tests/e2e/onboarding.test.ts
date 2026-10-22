import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { io, type Socket } from 'socket.io-client';
import { afterAll, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@behindveil/shared';

/**
 * 「新用户开箱」端到端（2026-10-08 可用性改造的回归网）。
 *
 * 守的是三件此前**页面上根本做不到**的事，全部只用页面会发出的请求完成——
 * 一旦有人把它们退回成「只能改配置文件 / 只能敲命令行」，这里立刻红：
 * ① 建房：POST /rooms 拿到邀请码（页面「新建房间」）；
 * ② 换模型：PATCH /llm 热更，不重启即生效（页面 AI 设置面板）；
 * ③ 剧本：POST /modules/samples 一键装载，开团下拉里能选到（页面剧本下拉）。
 *
 * 开团闭环单独一例并**注入 MockLlm**：换模型那一例故意留着一个连不通的端点
 * （要验证「配错了要报错、不能把服务搞瘫」），不适合再压 AI 链路。
 *
 * 与 tests/ 其他文件同口径：从**构建产物**取模块，需先 `pnpm build`。
 */
const SERVER_DIST = fileURLToPath(new URL('../../packages/server/dist', import.meta.url));

const { createServer } = (await import(pathToFileURL(path.join(SERVER_DIST, 'index.js')).href)) as {
  createServer(opts: Record<string, unknown>): Promise<AppLike>;
};
interface AppLike {
  listen(opts: { port: number; host: string }): Promise<unknown>;
  close(): Promise<void>;
  server: { address(): { port: number } | null };
}

const sockets: Socket[] = [];
const closers: Array<() => Promise<void>> = [];
const temps: string[] = [];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 沙箱里 rm 可能挂起（已知环境坑）：给清理加竞速，超时就放弃，不拖垮用例 */
async function rmQuietly(dir: string): Promise<void> {
  await Promise.race([rm(dir, { recursive: true, force: true }), sleep(2000)]);
}

afterAll(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const close of closers.splice(0)) await close();
  for (const dir of temps.splice(0)) await rmQuietly(dir);
});

async function api(base: string, p: string, method = 'GET', body?: unknown): Promise<Response> {
  return fetch(`${base}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function connect(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(`http://127.0.0.1:${port}`, {
      auth: { protocol: PROTOCOL_VERSION },
      transports: ['websocket'],
      reconnection: false,
    });
    sockets.push(socket);
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (err) => reject(new Error(err.message)));
  });
}

function emitAck(
  socket: Socket,
  event: string,
  payload: unknown,
  timeoutMs = 8000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    socket.emit(event, payload, (ack: unknown) => resolve(ack ?? { ok: false, message: '无 ack' }));
    setTimeout(() => resolve({ ok: false, message: `${event} 超时` }), timeoutMs);
  });
}

/** 一台「刚装好、还没配 AI」的机器：端点连不通，但配置本身合法 */
async function freshServer(
  opts: Record<string, unknown> = {},
): Promise<{ base: string; dataDir: string; port: number }> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'bv-onboard-'));
  temps.push(dataDir);
  // 一台「刚装好、还没配 AI」的机器：端点连不通，但配置本身合法
  {
    await writeFile(
      path.join(dataDir, 'config.yaml'),
      [
        'host: 127.0.0.1',
        'port: 8787',
        'llm:',
        '  provider: openai-compat',
        '  baseUrl: http://127.0.0.1:1/v1',
        '  model: broken',
      ].join('\n'),
      'utf8',
    );
  }
  const app = await createServer({ dataDir, logger: false, ...opts });
  closers.push(async () => app.close());
  await app.listen({ port: 0, host: '127.0.0.1' });
  await sleep(150);
  const port = (app.server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, dataDir, port };
}

describe('新用户开箱：建房 / 换模型 / 选剧本', () => {
  it('建房拿到邀请码；换模型热更即生效；一键装载剧本', async () => {
    const { base } = await freshServer();

    // ① 建房：页面「新建房间」就是这一个请求
    const created = await api(base, '/rooms', 'POST', { name: '开箱体验团', memberLimit: 6 });
    expect(created.status).toBe(201);
    const room = (await created.json()) as { inviteCode: string; hostToken: string };
    expect(room.inviteCode).toMatch(/^[A-Z0-9]{6}$/);
    expect(room.hostToken.length).toBeGreaterThan(0);

    // ② 换模型：先自检（坏地址要给人话），再保存（热更，不重启）
    const probe = (await (await api(base, '/llm/test', 'POST', {})).json()) as {
      ok: boolean;
      message?: string;
    };
    expect(probe.ok).toBe(false);
    expect(probe.message ?? '').toContain('连不上');

    const patched = (await (
      await api(base, '/llm', 'PATCH', { provider: 'mock', model: 'mock-1' })
    ).json()) as { ready: boolean; adapterId: string; source: string };
    expect(patched.ready).toBe(true);
    expect(patched.adapterId).toBe('mock');
    expect(patched.source).toBe('runtime');

    // 保存后再自检：用的是刚换上的适配器
    const probe2 = (await (await api(base, '/llm/test', 'POST', {})).json()) as { ok: boolean };
    expect(probe2.ok).toBe(true);

    // ③ 剧本：一键装载内置示例，开团下拉里能选到
    const installed = (await (await api(base, '/modules/samples', 'POST', {})).json()) as Array<{
      id: string;
      status: string;
    }>;
    expect(installed.length).toBeGreaterThan(0);
    expect(installed.every((m) => m.status === 'installed' || m.status === 'already')).toBe(true);

    const modules = (await (await api(base, '/modules')).json()) as Array<{
      id: string;
      name: string;
    }>;
    expect(modules.length).toBeGreaterThan(0);
  }, 60_000);

  /**
   * 建房者带着页面下发的 hostToken 进房 → 拿到 Host 角色（开团的前置）。
   *
   * 开团那一步（session:start + 模组六类机制 + 审计回放）由 m9 集成测试守，
   * 这里不重复压：本文件关心的是「页面能不能把人带进门」，不是团内的规则。
   */
  it('建房者凭页面下发的 hostToken 进房即 Host', async () => {
    const { base, port } = await freshServer();
    const room = (await (await api(base, '/rooms', 'POST', { name: '雾桥团' })).json()) as {
      inviteCode: string;
      hostToken: string;
    };
    const socket = await connect(port);
    const join = (await emitAck(socket, 'room:join', {
      inviteCode: room.inviteCode,
      name: '守秘人',
      hostToken: room.hostToken,
    })) as { ok: boolean; role?: string };
    expect(join.ok).toBe(true);
    expect(join.role).toBe('host');
  }, 60_000);
});
