import { SCHEMA_VERSION } from '@behindveil/shared';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as serverEntry from '../../packages/server/src/index.js';
import * as layoutEntry from '../../packages/server/src/adapters/storage/layout.js';
import * as globalIndexEntry from '../../packages/server/src/observability/global-index.js';

/**
 * M11 REST 契约（v3 T-M11-05 / T-M11-06，FR-34 / FR-35）。
 *
 * 三条守卫：
 * ① `GET /search` 是管理面只读出口——设了令牌就要头，没设才放行（与 /metrics 同款）；
 * ② 房间世界书 GET/PUT 是编辑器唯一写入口，**保存前必须校验**（结构错误 400 + 不落盘）；
 * ③ 模组世界书只读：拿得到条目，但没有写接口（改必须复制到房间层）。
 *
 * 导入源码而非 dist：dist 缺失会静默变成 skipped，那等于门禁睁一只眼（v1 教训）。
 */

const serverModule = serverEntry as unknown as Record<string, unknown>;
const { createDataLayout } = layoutEntry as unknown as {
  createDataLayout: (root: string) => { globalIndexFile: string; roomsDir: string };
};
const { rebuildGlobalIndex } = globalIndexEntry as unknown as {
  rebuildGlobalIndex: (dataDir: string) => Promise<{ entries: number; badLines: number }>;
};

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

const created: string[] = [];
const apps: AppLike[] = [];
const asRecord = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

async function makeApp(env?: Record<string, string>): Promise<{ app: AppLike; dataDir: string }> {
  const create = serverModule['createServer'] as (
    opts: Record<string, unknown>,
  ) => Promise<AppLike>;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'bv-m11-rest-'));
  created.push(dataDir);

  const saved: Array<[string, string | undefined]> = [];
  for (const [key, value] of Object.entries(env ?? {})) {
    saved.push([key, process.env[key]]);
    process.env[key] = value;
  }
  try {
    const app = await create({ dataDir, logger: false });
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

const ADMIN_TOKEN = 'm11-admin-token';
let secured: { app: AppLike; dataDir: string } | null = null;
let open: { app: AppLike; dataDir: string } | null = null;

beforeAll(async () => {
  secured = await makeApp({ AIDLE_ADMIN_TOKEN: ADMIN_TOKEN });
  open = await makeApp();
});

/** 清理带超时竞速（沙箱 rm 会挂起，直接 await 会把整条用例判红） */
async function rmQuietly(dir: string): Promise<void> {
  await Promise.race([
    rm(dir, { recursive: true, force: true }).catch(() => undefined),
    new Promise((r) => setTimeout(r, 2_000)),
  ]);
}

afterAll(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const dir of created.splice(0)) await rmQuietly(dir);
});

const HEADERS = { 'x-admin-token': ADMIN_TOKEN };

async function createRoom(app: AppLike): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/rooms',
    headers: HEADERS,
    payload: { name: '雾桥驿站' },
  });
  expect(res.statusCode, res.body).toBe(201);
  return String(asRecord(res.json())['id']);
}

describe('GET /search：跨房间检索（FR-34）', () => {
  it('索引为空时检索返回空列表，不是 404', async () => {
    expect(secured).not.toBeNull();
    const res = await secured!.app.inject({
      method: 'GET',
      url: '/search?q=雾',
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(200);
    expect(asRecord(res.json())['hits']).toEqual([]);
  });

  it('命中按索引行返回：含房间/会话/seq/来源文本', async () => {
    expect(secured).not.toBeNull();
    const layout = createDataLayout(secured!.dataDir);
    const roomId = 'r_seed';
    const dir = path.join(layout.roomsDir, roomId, 'sessions', 'ses_1');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'messages.jsonl'),
      `${JSON.stringify({
        seq: 1,
        ts: '2026-10-04T00:00:00.000Z',
        sessionId: 'ses_1',
        type: 'ic',
        senderId: 'mem_1',
        content: '雾中的灯塔亮了',
      })}\n`,
      'utf8',
    );
    await rebuildGlobalIndex(secured!.dataDir);

    const res = await secured!.app.inject({
      method: 'GET',
      url: '/search?q=灯塔',
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(200);
    const body = asRecord(res.json());
    const hits = body['hits'] as Array<Record<string, unknown>>;
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ roomId, sessionId: 'ses_1', seq: 1, type: 'ic' });
    expect(String(hits[0]!['content'])).toContain('灯塔');
  });

  it('管理面门禁：无头/错头 401；未设令牌时才放行（与 /metrics 同款口径）', async () => {
    expect(secured).not.toBeNull();
    const denied = await secured!.app.inject({ method: 'GET', url: '/search?q=x' });
    expect(denied.statusCode).toBe(401);

    const wrong = await secured!.app.inject({
      method: 'GET',
      url: '/search?q=x',
      headers: { 'x-admin-token': 'wrong' },
    });
    expect(wrong.statusCode).toBe(401);

    expect(open).not.toBeNull();
    const allowed = await open!.app.inject({ method: 'GET', url: '/search?q=x' });
    expect(allowed.statusCode).toBe(200);
  });
});

const entry = (uid: number, key: string): Record<string, unknown> => ({
  uid,
  key: [key],
  keysecondary: [],
  selectiveLogic: 0,
  content: `${key}条目内容`,
  position: 'before_char',
  order: 100,
  weight: 100,
  constant: false,
  disabled: false,
});

describe('世界书编辑器 REST（FR-35）', () => {
  it('GET 空世界书 → 200 + 空条目', async () => {
    expect(secured).not.toBeNull();
    const roomId = await createRoom(secured!.app);
    const res = await secured!.app.inject({
      method: 'GET',
      url: `/rooms/${roomId}/worldbook`,
      headers: HEADERS,
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = asRecord(res.json());
    expect(body['entries']).toEqual([]);
    expect(body['warnings']).toEqual([]);
  });

  it('PUT → GET roundtrip：保存的内容原样读回', async () => {
    expect(secured).not.toBeNull();
    const roomId = await createRoom(secured!.app);
    const put = await secured!.app.inject({
      method: 'PUT',
      url: `/rooms/${roomId}/worldbook`,
      headers: { ...HEADERS, 'content-type': 'application/json' },
      payload: { entries: [entry(1, '灯塔'), entry(2, '雾号')] },
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(asRecord(put.json())['entries']).toHaveLength(2);

    const get = await secured!.app.inject({
      method: 'GET',
      url: `/rooms/${roomId}/worldbook`,
      headers: HEADERS,
    });
    const entries = asRecord(get.json())['entries'] as Array<Record<string, unknown>>;
    expect(entries.map((e) => e['uid'])).toEqual([1, 2]);
    expect(entries[0]).toMatchObject({ uid: 1, key: ['灯塔'] });
  });

  it('结构错误（uid 重复）→ 400 且**不落盘**（D-08）', async () => {
    expect(secured).not.toBeNull();
    const roomId = await createRoom(secured!.app);
    await secured!.app.inject({
      method: 'PUT',
      url: `/rooms/${roomId}/worldbook`,
      headers: { ...HEADERS, 'content-type': 'application/json' },
      payload: { entries: [entry(1, '灯塔')] },
    });

    const bad = await secured!.app.inject({
      method: 'PUT',
      url: `/rooms/${roomId}/worldbook`,
      headers: { ...HEADERS, 'content-type': 'application/json' },
      payload: { entries: [entry(1, '灯塔'), entry(1, '雾号')] },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain('uid 重复');

    const get = await secured!.app.inject({
      method: 'GET',
      url: `/rooms/${roomId}/worldbook`,
      headers: HEADERS,
    });
    expect(asRecord(get.json())['entries']).toHaveLength(1);
  });

  it('语义隐患（非常驻无关键词）→ 200 保存成功但带回告警', async () => {
    expect(secured).not.toBeNull();
    const roomId = await createRoom(secured!.app);
    const res = await secured!.app.inject({
      method: 'PUT',
      url: `/rooms/${roomId}/worldbook`,
      headers: { ...HEADERS, 'content-type': 'application/json' },
      payload: { entries: [{ ...entry(1, '灯塔'), key: [] }] },
    });
    expect(res.statusCode, res.body).toBe(200);
    const warnings = asRecord(res.json())['warnings'] as string[];
    expect(warnings.join('\n')).toContain('永远不会命中');
  });

  it('落盘带 schemaVersion（M11 起收编进迁移管辖）', async () => {
    expect(secured).not.toBeNull();
    const roomId = await createRoom(secured!.app);
    await secured!.app.inject({
      method: 'PUT',
      url: `/rooms/${roomId}/worldbook`,
      headers: { ...HEADERS, 'content-type': 'application/json' },
      payload: { entries: [entry(1, '灯塔')] },
    });
    const layout = createDataLayout(secured!.dataDir);
    const raw = JSON.parse(
      await readFile(path.join(layout.roomsDir, roomId, 'worldbook.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(raw['schemaVersion']).toBe(SCHEMA_VERSION);
  });

  it('模组世界书只读：GET 可得，不存在的模组 404；没有 PUT 接口', async () => {
    expect(secured).not.toBeNull();
    const missing = await secured!.app.inject({
      method: 'GET',
      url: '/modules/nope/worldbook',
      headers: HEADERS,
    });
    expect(missing.statusCode).toBe(404);

    // 写接口不存在：PUT 应落到 404（路由未注册）而不是 200
    const put = await secured!.app.inject({
      method: 'PUT',
      url: '/modules/nope/worldbook',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      payload: { entries: [] },
    });
    expect(put.statusCode).not.toBe(200);
  });

  it('编辑端点同样受管理令牌保护', async () => {
    expect(secured).not.toBeNull();
    const roomId = await createRoom(secured!.app);
    const denied = await secured!.app.inject({
      method: 'GET',
      url: `/rooms/${roomId}/worldbook`,
    });
    expect(denied.statusCode).toBe(401);
  });
});
