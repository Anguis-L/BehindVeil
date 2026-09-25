import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataLayout, type DataLayout } from '../../adapters/storage/layout.js';
import { appendMessage } from '../../domain/session/messages.js';
import { createRoom } from '../../domain/session/rooms.js';
import { createSession } from '../../domain/session/sessions.js';
import { registerRoomRoutes } from './rooms.js';
import type { Message } from '@behindveil/shared';

/**
 * T-M1-02/07/09：管理面 REST 单测（与 tests/http/rest-contract 互补——
 * 那边走 dist 装配根测契约，这里直挂 registerRoomRoutes 补齐：
 * 会话列表 / 结束 / 活跃切换端点、400 分支、门禁 401、未开团空历史）。
 */

const settings = {
  provider: 'openai-compat',
  model: 'deepseek-chat',
  temperature: 0.7,
  maxHistoryMessages: 40,
  worldBookBudgetTokens: 2000,
  scanDepth: 4,
  contextWindowTokens: 32_768,
  outputReserveTokens: 2_048,
};

const created: string[] = [];
let dataDir = '';
let layout: DataLayout;
let app: FastifyInstance;
let secured: FastifyInstance;
const ADMIN_TOKEN = 'secret-admin-456';

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'bv-http-rooms-'));
  created.push(dataDir);
  layout = createDataLayout(dataDir);

  app = Fastify({ logger: false });
  registerRoomRoutes(app, { layout, adminToken: undefined });
  await app.ready();

  secured = Fastify({ logger: false });
  registerRoomRoutes(secured, { layout: createDataLayout(dataDir), adminToken: ADMIN_TOKEN });
  await secured.ready();
});

afterAll(async () => {
  await Promise.all([app.close(), secured.close()]);
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function newRoom(name = '测试房') {
  return createRoom(layout, { name });
}

async function newSession(roomId: string, moduleId = 'mod-1') {
  return createSession(layout, roomId, { moduleId, settings });
}

const icMsg = (sessionId: string, seq: number): Message => ({
  seq,
  ts: '2026-09-25T04:00:00.000Z',
  sessionId,
  type: 'ic',
  senderId: 'm_a',
  content: `第 ${seq} 条`,
});

describe('POST /rooms：校验分支（E-ROOM-01）', () => {
  it('非法 body（数组）→ 400，错误信息带 (根) 前缀', async () => {
    const res = await app.inject({ method: 'POST', url: '/rooms', payload: [1, 2] });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'E-ROOM-01' });
    expect(String((res.json() as { message: string }).message)).toContain('(根)');
  });

  it('memberLimit 越界 → 400，错误信息带字段路径', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/rooms',
      payload: { name: 'x', memberLimit: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect(String((res.json() as { message: string }).message)).toContain('memberLimit');
  });
});

describe('管理面门禁（决议 ②）', () => {
  it('未设置 AIDLE_ADMIN_TOKEN 时不启用门禁（零配置）', async () => {
    const res = await app.inject({ method: 'GET', url: '/rooms' });
    expect(res.statusCode).toBe(200);
  });

  it('设置后：无令牌 / 错令牌 → 401', async () => {
    expect((await secured.inject({ method: 'GET', url: '/rooms' })).statusCode).toBe(401);
    expect(
      (
        await secured.inject({
          method: 'GET',
          url: '/rooms',
          headers: { 'X-Admin-Token': 'wrong' },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('对令牌放行', async () => {
    const res = await secured.inject({
      method: 'GET',
      url: '/rooms',
      headers: { 'X-Admin-Token': ADMIN_TOKEN },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('GET /rooms/:roomId/sessions（T-M1-07）', () => {
  it('未知房间 → 404', async () => {
    expect((await app.inject({ method: 'GET', url: '/rooms/nope/sessions' })).statusCode).toBe(404);
  });

  it('返回会话数组（含活跃会话）', async () => {
    const room = await newRoom();
    const session = await newSession(room.id);

    const res = await app.inject({ method: 'GET', url: `/rooms/${room.id}/sessions` });
    expect(res.statusCode).toBe(200);
    const sessions = res.json() as Array<{ id: string }>;
    expect(sessions.map((s) => s.id)).toContain(session.id);
  });
});

describe('POST /rooms/:roomId/sessions/:sessionId/end（T-M1-07 提案端点）', () => {
  it('结束活跃会话：endedAt 置位', async () => {
    const room = await newRoom();
    const session = await newSession(room.id);

    const res = await app.inject({
      method: 'POST',
      url: `/rooms/${room.id}/sessions/${session.id}/end`,
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { endedAt: string | null }).endedAt).not.toBeNull();
  });

  it('未知会话 → 404', async () => {
    const room = await newRoom();
    const res = await app.inject({
      method: 'POST',
      url: `/rooms/${room.id}/sessions/s_missing/end`,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('PUT /rooms/:roomId/active-session（FR-11 提案端点）', () => {
  it('切换活跃会话；未知会话 → 404；非法 body → 400', async () => {
    const room = await newRoom();
    const first = await newSession(room.id);
    const second = await newSession(room.id);

    const ok = await app.inject({
      method: 'PUT',
      url: `/rooms/${room.id}/active-session`,
      payload: { sessionId: first.id },
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { id: string }).id).toBe(first.id);
    expect(second.endedAt).toBeNull(); // 复播不改会话本身

    const missing = await app.inject({
      method: 'PUT',
      url: `/rooms/${room.id}/active-session`,
      payload: { sessionId: 's_missing' },
    });
    expect(missing.statusCode).toBe(404);

    const bad = await app.inject({
      method: 'PUT',
      url: `/rooms/${room.id}/active-session`,
      payload: {},
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('GET /rooms/:roomId/messages（决议 ④）', () => {
  it('beforeSeq / limit 非法 → 400', async () => {
    const room = await newRoom();
    const base = `/rooms/${room.id}/messages?sessionId=s_1`;
    expect((await app.inject({ method: 'GET', url: `${base}&beforeSeq=-1` })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `${base}&beforeSeq=1.5` })).statusCode).toBe(
      400,
    );
    expect((await app.inject({ method: 'GET', url: `${base}&limit=abc` })).statusCode).toBe(400);
  });

  it('未知房间 → 404', async () => {
    expect(
      (await app.inject({ method: 'GET', url: '/rooms/nope/messages?sessionId=s_1' })).statusCode,
    ).toBe(404);
  });

  it('未开团且未传 sessionId → 空数组', async () => {
    const room = await newRoom();
    const res = await app.inject({ method: 'GET', url: `/rooms/${room.id}/messages` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('缺省取活跃会话；excludeHidden 剔除暗骰', async () => {
    const room = await newRoom();
    const session = await newSession(room.id);
    await appendMessage(layout, room.id, session.id, icMsg(session.id, 1));
    await appendMessage(layout, room.id, session.id, {
      ...icMsg(session.id, 2),
      type: 'dice',
      roll: {
        expr: '1d100',
        rolls: [[42]],
        kept: [42],
        total: 42,
        audit: { seq: 'a-1', ts: '2026-09-25T04:00:00.000Z', rollId: 'roll-1' },
      },
      hidden: true,
    } as unknown as Message);

    const res = await app.inject({ method: 'GET', url: `/rooms/${room.id}/messages` });
    expect(res.statusCode).toBe(200);
    const messages = res.json() as Array<{ seq: number; type: string }>;
    expect(messages.map((m) => m.seq)).toEqual([1]); // 暗骰被剔除
  });
});
