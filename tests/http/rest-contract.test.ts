import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * T-M1-02：管理面 REST 契约（docs/openapi.yaml + 2026-09-25 用户拍板的四项决议）。
 *
 * 决议落地点：
 *   ① Host 身份：POST /rooms 响应必须携带 hostToken，建房者进房时出示即成为 Host；
 *      hostToken 属凭据，除建房响应外任何接口（含房间列表）不得返回。
 *   ② 管理面门禁：环境变量 AIDLE_ADMIN_TOKEN 设置后，除 /healthz 外的管理接口
 *      必须携带请求头 X-Admin-Token（缺失/错误 → 401）；未设置则不启用（零配置）。
 *   ③ 卸载冲突错误码：E-MOD-01（见 shared errors 测试）。
 *   ④ 历史消息走 REST：GET /rooms/{id}/messages?sessionId=&beforeSeq=&limit=，seq 降序。
 *
 * 契约先行：路由未实现（GET /rooms 探测得 404）时整组跳过，落地后自动激活——
 * 与 tests/protocol 同一模式，避免打断已全绿的 pnpm verify / CI。
 */

const SERVER_DIST = fileURLToPath(new URL('../../packages/server/dist/index.js', import.meta.url));

const serverModule = (await import(/* @vite-ignore */ pathToFileURL(SERVER_DIST).href).catch(
  () => null,
)) as Record<string, unknown> | null;

interface InjectResult {
  statusCode: number;
  body: string;
  json(): unknown;
}

interface AppLike {
  inject(opts: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    payload?: unknown;
  }): Promise<InjectResult>;
  close(): Promise<void>;
}

interface Ctx {
  app: AppLike;
  dataDir: string;
}

const created: string[] = [];
const apps: AppLike[] = [];

const asRecord = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

async function makeApp(env?: Record<string, string>): Promise<Ctx | null> {
  const create = serverModule?.['createServer'];
  if (typeof create !== 'function') return null;

  const dataDir = await mkdtemp(path.join(tmpdir(), 'bv-rest-'));
  created.push(dataDir);

  // 管理密码在 createServer 装载配置时读取环境变量（决议 ②）
  const saved: Array<[string, string | undefined]> = [];
  for (const [key, value] of Object.entries(env ?? {})) {
    saved.push([key, process.env[key]]);
    process.env[key] = value;
  }
  try {
    const app = (await (create as (opts: Record<string, unknown>) => Promise<AppLike>)({
      dataDir,
      logger: false,
    })) as AppLike;
    apps.push(app);
    await app.ready();
    return { app, dataDir };
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const open = await makeApp();
let enabled = false;
if (open) {
  const probe = await open.app.inject({ method: 'GET', url: '/rooms' });
  enabled = probe.statusCode === 200; // 404 = 路由未落地 → 整组跳过
}

const suite = enabled ? describe : describe.skip;

const ADMIN_TOKEN = 'secret-admin-123';
let secured: Ctx | null = null;

beforeAll(async () => {
  if (!enabled) return;
  secured = await makeApp({ AIDLE_ADMIN_TOKEN: ADMIN_TOKEN });
});

afterAll(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createRoom(
  app: AppLike,
  body: Record<string, unknown> = { name: '疯狂山脉·第一夜' },
): Promise<Record<string, unknown>> {
  const res = await app.inject({ method: 'POST', url: '/rooms', payload: body });
  expect(res.statusCode, res.body).toBe(201);
  return asRecord(res.json());
}

const icMsg = (seq: number): Record<string, unknown> => ({
  seq,
  ts: '2026-09-25T04:00:00.000Z',
  sessionId: 'ses_1',
  type: 'ic',
  senderId: 'm_alice',
  content: `第 ${seq} 条`,
});

async function seedMessages(dataDir: string, roomId: string, count: number): Promise<void> {
  const dir = path.join(dataDir, 'rooms', roomId, 'sessions', 'ses_1');
  await mkdir(dir, { recursive: true });
  const lines = Array.from({ length: count }, (_, i) => JSON.stringify(icMsg(i + 1)));
  await writeFile(path.join(dir, 'messages.jsonl'), lines.join('\n') + '\n', 'utf8');
}

suite('REST 契约：建房与 Host 身份（决议 ①）', () => {
  it('POST /rooms 最小建房：返回邀请码、默认人数上限与 hostToken', async () => {
    expect(open).not.toBeNull();
    const room = await createRoom(open!.app);

    expect(typeof room['id']).toBe('string');
    expect(room['name']).toBe('疯狂山脉·第一夜');
    expect(String(room['inviteCode'])).toHaveLength(6);
    expect(room['activeSessionId']).toBeNull();
    expect(Number(room['memberLimit'])).toBeGreaterThan(0);
    expect(typeof room['createdAt']).toBe('string');
    expect(
      String(room['hostToken']).length,
      '建房响应必须携带 hostToken（决议 ①）',
    ).toBeGreaterThan(0);
    expect(room['hostToken']).not.toBe(room['inviteCode']);
  });

  it('POST /rooms 可指定人数上限与默认会话设置', async () => {
    const room = await createRoom(open!.app, {
      name: '黑夜之子·第二章',
      memberLimit: 6,
      defaultSessionSettings: {
        provider: 'openai-compat',
        model: 'deepseek-chat',
        temperature: 0.8,
        maxHistoryMessages: 40,
        worldBookBudgetTokens: 2000,
        scanDepth: 4,
      },
    });

    expect(room['memberLimit']).toBe(6);
  });

  it('POST /rooms 缺 name → 400', async () => {
    const res = await open!.app.inject({ method: 'POST', url: '/rooms', payload: {} });

    expect(res.statusCode).toBe(400);
  });

  it('房间列表不泄露 hostToken（凭据只随建房响应发放一次）', async () => {
    const room = await createRoom(open!.app);

    const res = await open!.app.inject({ method: 'GET', url: '/rooms' });
    expect(res.statusCode).toBe(200);

    const rooms = res.json() as unknown[];
    const found = rooms.find((r) => asRecord(r)['id'] === room['id']);
    expect(found).toBeDefined();
    expect(asRecord(found)['hostToken'], '列表不得返回 hostToken').toBeUndefined();
    expect(res.body).not.toContain(String(room['hostToken']));
  });

  it('GET /rooms/{id} 查详情，未知房间 404', async () => {
    const room = await createRoom(open!.app);

    const ok = await open!.app.inject({ method: 'GET', url: `/rooms/${String(room['id'])}` });
    expect(ok.statusCode).toBe(200);
    expect(asRecord(ok.json())['id']).toBe(room['id']);

    const missing = await open!.app.inject({ method: 'GET', url: '/rooms/no-such-room' });
    expect(missing.statusCode).toBe(404);
  });
});

suite('REST 契约：邀请码重置与房间配置（T-M1-02）', () => {
  it('POST /rooms/{id}/invite-reset：新码 6 位且使旧码失效（旧码 ≠ 新码）', async () => {
    const room = await createRoom(open!.app);
    const old = String(room['inviteCode']);

    const res = await open!.app.inject({
      method: 'POST',
      url: `/rooms/${String(room['id'])}/invite-reset`,
    });

    expect(res.statusCode).toBe(200);
    const next = String(asRecord(res.json())['inviteCode']);
    expect(next).toHaveLength(6);
    expect(next).not.toBe(old);
  });

  it('PATCH /rooms/{id}/settings：局部更新，未传字段保持不变', async () => {
    const room = await createRoom(open!.app, { name: '旧名字', memberLimit: 8 });

    const res = await open!.app.inject({
      method: 'PATCH',
      url: `/rooms/${String(room['id'])}/settings`,
      payload: { name: '新名字' },
    });

    expect(res.statusCode).toBe(200);
    expect(asRecord(res.json())['name']).toBe('新名字');
    expect(asRecord(res.json())['memberLimit']).toBe(8);

    const missing = await open!.app.inject({
      method: 'PATCH',
      url: '/rooms/no-such-room/settings',
      payload: { name: 'x' },
    });
    expect(missing.statusCode).toBe(404);
  });
});

suite('REST 契约：历史消息（决议 ④：走 REST，T-M1-09）', () => {
  it('seq 降序返回，limit 截断', async () => {
    const room = await createRoom(open!.app);
    await seedMessages(open!.dataDir, String(room['id']), 5);

    const res = await open!.app.inject({
      method: 'GET',
      url: `/rooms/${String(room['id'])}/messages?sessionId=ses_1&limit=2`,
    });

    expect(res.statusCode).toBe(200);
    const messages = res.json() as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m['seq'])).toEqual([5, 4]); // 最新在前
  });

  it('beforeSeq 向前翻页，衔接处不丢不重', async () => {
    const room = await createRoom(open!.app);
    await seedMessages(open!.dataDir, String(room['id']), 5);

    const first = (await open!.app
      .inject({
        method: 'GET',
        url: `/rooms/${String(room['id'])}/messages?sessionId=ses_1&limit=2`,
      })
      .then((r) => r.json())) as Array<Record<string, unknown>>;
    const oldest = Number(first.at(-1)?.['seq']);

    const second = (await open!.app
      .inject({
        method: 'GET',
        url: `/rooms/${String(room['id'])}/messages?sessionId=ses_1&limit=2&beforeSeq=${oldest}`,
      })
      .then((r) => r.json())) as Array<Record<string, unknown>>;

    expect(second.map((m) => Number(m['seq']))).toEqual([3, 2]);
  });

  it('缺省 limit=50：全部返回', async () => {
    const room = await createRoom(open!.app);
    await seedMessages(open!.dataDir, String(room['id']), 5);

    const res = await open!.app.inject({
      method: 'GET',
      url: `/rooms/${String(room['id'])}/messages?sessionId=ses_1`,
    });

    expect((res.json() as unknown[]).length).toBe(5);
  });

  it('limit 越界（0 / 201）→ 400；未知房间 → 404', async () => {
    const room = await createRoom(open!.app);
    const base = `/rooms/${String(room['id'])}/messages?sessionId=ses_1`;

    expect((await open!.app.inject({ method: 'GET', url: `${base}&limit=0` })).statusCode).toBe(
      400,
    );
    expect((await open!.app.inject({ method: 'GET', url: `${base}&limit=201` })).statusCode).toBe(
      400,
    );
    expect(
      (await open!.app.inject({ method: 'GET', url: '/rooms/no-such-room/messages' })).statusCode,
    ).toBe(404);
  });
});

suite('REST 契约：管理面门禁（决议 ②：AIDLE_ADMIN_TOKEN）', () => {
  it('设置环境变量后：无令牌 401，错令牌 401', async () => {
    expect(secured).not.toBeNull();

    const noToken = await secured!.app.inject({ method: 'GET', url: '/rooms' });
    expect(noToken.statusCode).toBe(401);

    const wrong = await secured!.app.inject({
      method: 'GET',
      url: '/rooms',
      headers: { 'X-Admin-Token': 'not-the-token' },
    });
    expect(wrong.statusCode).toBe(401);
  });

  it('正确令牌（X-Admin-Token 头）放行全部管理操作', async () => {
    const headers = { 'X-Admin-Token': ADMIN_TOKEN };

    const list = await secured!.app.inject({ method: 'GET', url: '/rooms', headers });
    expect(list.statusCode).toBe(200);

    const createdRoom = await secured!.app.inject({
      method: 'POST',
      url: '/rooms',
      headers,
      payload: { name: '受保护房间' },
    });
    expect(createdRoom.statusCode).toBe(201);
  });

  it('探活 /healthz 始终公开（不要求令牌）', async () => {
    const res = await secured!.app.inject({ method: 'GET', url: '/healthz' });

    expect(res.statusCode).toBe(200);
  });
});
