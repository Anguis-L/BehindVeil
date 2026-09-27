import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Member, Room } from '@behindveil/shared';
import { createDataLayout, type DataLayout } from '../../adapters/storage/layout.js';
import { saveCard } from '../../domain/character/library.js';
import { addMember } from '../../domain/session/members.js';
import { createRoom } from '../../domain/session/rooms.js';
import { registerPcRoutes } from './pcs.js';

/**
 * T-M5-04：PC 声明 REST。沿用 cards.test.ts 写法（open 实例 + secured 实例对拍门禁）。
 * 覆盖两条声明路径（卡库 pcSheet / 速建表）与非 PC 卡、未知成员/房间等失败分支。
 */

const created: string[] = [];
let layout: DataLayout;
let app: FastifyInstance;
let secured: FastifyInstance;
const ADMIN_TOKEN = 'secret-admin-456';

let roomId: string;
let memberId: string;

const SHEET = {
  playerName: '爱丽丝',
  occupation: '记者',
  str: 50,
  con: 60,
  siz: 55,
  dex: 70,
  app: 50,
  int: 75,
  pow: 55,
  edu: 80,
  luck: 40,
  hp: 11,
  mp: 11,
  san: 55,
  db: '0',
  build: '0',
  skills: { 侦查: 60 },
};

const pcCard = {
  spec: 'chara_card_v3',
  data: {
    name: '爱丽丝',
    description: '记者，眼神锐利。',
    scenario: '',
    first_mes: '',
    mes_example: '',
    extensions: { aidle: { rulebook: 'coc7', pcSheet: SHEET } },
  },
};

const kpCard = {
  spec: 'chara_card_v3',
  data: {
    name: '守秘人',
    description: '只叙述，不宣告判定。',
    scenario: '',
    first_mes: '',
    mes_example: '',
    extensions: { aidle: { rulebook: 'coc7' } },
  },
};

beforeAll(async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'bv-http-pcs-'));
  created.push(dataDir);
  layout = createDataLayout(dataDir);

  app = Fastify({ logger: false });
  registerPcRoutes(app, { layout, adminToken: undefined });
  await app.ready();

  secured = Fastify({ logger: false });
  registerPcRoutes(secured, { layout, adminToken: ADMIN_TOKEN });
  await secured.ready();

  const room: Room = await createRoom(layout, { name: '测试团' });
  roomId = room.id;
  const member: Member = await addMember(layout, roomId, { name: '玩家甲', role: 'player' });
  memberId = member.id;
});

afterAll(async () => {
  await Promise.all([app.close(), secured.close()]);
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}, 120_000);

describe('PUT /rooms/:roomId/pcs/:memberId', () => {
  it('cardId 路径：PC 卡 pcSheet 进名册，source=card 并带 cardId', async () => {
    const saved = await saveCard(layout, 'alice.json', Buffer.from(JSON.stringify(pcCard)));
    expect(saved.ok).toBe(true);
    const res = await app.inject({
      method: 'PUT',
      url: `/rooms/${roomId}/pcs/${memberId}`,
      payload: { cardId: 'alice.json' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ memberId, source: 'card', cardId: 'alice.json' });
    expect((res.json() as { sheet: { playerName: string } }).sheet.playerName).toBe('爱丽丝');
  });

  it('KP 卡（无 pcSheet）→ 400 E-CARD-01', async () => {
    await saveCard(layout, 'keeper.json', Buffer.from(JSON.stringify(kpCard)));
    const res = await app.inject({
      method: 'PUT',
      url: `/rooms/${roomId}/pcs/${memberId}`,
      payload: { cardId: 'keeper.json' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'E-CARD-01' });
  });

  it('卡不存在 → 400 E-CARD-01', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/rooms/${roomId}/pcs/${memberId}`,
      payload: { cardId: 'ghost.json' },
    });
    expect(res.json()).toMatchObject({ code: 'E-CARD-01' });
  });

  it('sheet 路径：无卡速建表直填，source=manual', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/rooms/${roomId}/pcs/${memberId}`,
      payload: { sheet: SHEET },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ memberId, source: 'manual' });
  });

  it.each([
    ['cardId 与 sheet 同给', { cardId: 'alice.json', sheet: SHEET }],
    ['cardId 与 sheet 都缺', {}],
  ])('%s → 400', async (_name, payload) => {
    const res = await app.inject({
      method: 'PUT',
      url: `/rooms/${roomId}/pcs/${memberId}`,
      payload,
    });
    expect(res.statusCode).toBe(400);
  });

  it('未知成员 → 400；未知房间 → 404', async () => {
    const missingMember = await app.inject({
      method: 'PUT',
      url: `/rooms/${roomId}/pcs/ghost-member`,
      payload: { sheet: SHEET },
    });
    expect(missingMember.statusCode).toBe(400);
    const missingRoom = await app.inject({
      method: 'PUT',
      url: '/rooms/ghost-room/pcs/x',
      payload: { sheet: SHEET },
    });
    expect(missingRoom.statusCode).toBe(404);
  });
});

describe('GET /rooms/:roomId/pcs', () => {
  it('列当前声明（memberId + 声明体）', async () => {
    const res = await app.inject({ method: 'GET', url: `/rooms/${roomId}/pcs` });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Array<{ memberId: string; source: string }>;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ memberId, source: 'manual' });
  });

  it('未知房间 → 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/rooms/ghost-room/pcs' });
    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /rooms/:roomId/pcs/:memberId', () => {
  it('撤销声明 → 204；再删 → 404', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/rooms/${roomId}/pcs/${memberId}` });
    expect(res.statusCode).toBe(204);
    const again = await app.inject({
      method: 'DELETE',
      url: `/rooms/${roomId}/pcs/${memberId}`,
    });
    expect(again.statusCode).toBe(404);
  });
});

describe('管理面门禁（决议 ②）', () => {
  it('设置令牌后无头 → 401', async () => {
    const res = await secured.inject({ method: 'GET', url: `/rooms/${roomId}/pcs` });
    expect(res.statusCode).toBe(401);
  });
});
