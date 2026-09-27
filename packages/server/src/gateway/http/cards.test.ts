import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CardEntry } from '@behindveil/shared';
import { createDataLayout, type DataLayout } from '../../adapters/storage/layout.js';
import { writeCardToPng } from '../../domain/character/png.js';
import { registerCardRoutes } from './cards.js';

/**
 * T-M5-09：卡库 REST。沿用 rooms.test.ts 的写法（open 实例 + secured 实例对拍门禁）。
 */

const created: string[] = [];
let layout: DataLayout;
let app: FastifyInstance;
let secured: FastifyInstance;
const ADMIN_TOKEN = 'secret-admin-789';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const keeperCard = {
  spec: 'chara_card_v3',
  spec_version: '3.0',
  data: {
    name: '守秘人',
    description: '只叙述，不宣告判定',
    scenario: '深夜书房',
    first_mes: '灯亮了。',
    mes_example: '',
    extensions: { aidle: { rulebook: 'coc7' } },
  },
};

beforeAll(async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'bv-http-cards-'));
  created.push(dataDir);
  layout = createDataLayout(dataDir);

  app = Fastify({ logger: false });
  registerCardRoutes(app, { layout, adminToken: undefined });
  await app.ready();

  secured = Fastify({ logger: false });
  registerCardRoutes(secured, { layout, adminToken: ADMIN_TOKEN });
  await secured.ready();
});

afterAll(async () => {
  await Promise.all([app.close(), secured.close()]);
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}, 120_000);

const upload = (fileName: string, bytes: Buffer) => ({
  fileName,
  contentBase64: bytes.toString('base64'),
});

describe('POST /cards', () => {
  it('PNG 卡入库 → 201，返回条目', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/cards',
      payload: upload('keeper.png', writeCardToPng(PNG_1X1, JSON.stringify(keeperCard))),
    });
    expect(res.statusCode).toBe(201);
    const entry = res.json() as CardEntry;
    expect(entry.name).toBe('守秘人');
    expect(entry.rulebook).toBe('coc7');
    expect(entry.kind).toBe('kp');
    expect(entry.source).toBe('png');
  });

  it('JSON 卡入库 → 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/cards',
      payload: upload('keeper.json', Buffer.from(JSON.stringify(keeperCard), 'utf8')),
    });
    expect(res.statusCode).toBe(201);
  });

  it('坏卡 → 400，信息定位到失败步骤（三步导入流）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/cards',
      payload: upload('broken.json', Buffer.from('{"hello":"world"}', 'utf8')),
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { code: string; message: string };
    expect(body.code).toBe('E-CARD-01');
    expect(body.message).toContain('detect');
  });

  it('body 非法 → 400', async () => {
    expect((await app.inject({ method: 'POST', url: '/cards', payload: {} })).statusCode).toBe(400);
  });
});

describe('GET /cards/:cardId', () => {
  it('返回卡片全文（含 extensions）', async () => {
    const res = await app.inject({ method: 'GET', url: '/cards/keeper.png' });
    expect(res.statusCode).toBe(200);
    const card = res.json() as {
      data: { name: string; extensions: { aidle: { rulebook: string } } };
    };
    expect(card.data.name).toBe('守秘人');
    expect(card.data.extensions.aidle.rulebook).toBe('coc7');
  });

  it('不存在 → 404', async () => {
    expect((await app.inject({ method: 'GET', url: '/cards/nope.png' })).statusCode).toBe(404);
  });
});

describe('GET /cards', () => {
  it('列出已入库卡片，按文件名排序', async () => {
    const res = await app.inject({ method: 'GET', url: '/cards' });
    expect(res.statusCode).toBe(200);
    const entries = res.json() as CardEntry[];
    expect(entries.map((e) => e.id).sort()).toEqual(['keeper.json', 'keeper.png']);
  });
});

describe('DELETE /cards/:cardId', () => {
  it('删除 → 204；再删 → 404', async () => {
    expect((await app.inject({ method: 'DELETE', url: '/cards/keeper.json' })).statusCode).toBe(
      204,
    );
    expect((await app.inject({ method: 'DELETE', url: '/cards/keeper.json' })).statusCode).toBe(
      404,
    );
  });
});

describe('卡库管理面门禁（决议 ②）', () => {
  it('未设置令牌时开放（零配置）', async () => {
    expect((await app.inject({ method: 'GET', url: '/cards' })).statusCode).toBe(200);
  });

  it('设置后：无令牌/错令牌 → 401，对令牌放行', async () => {
    expect((await secured.inject({ method: 'GET', url: '/cards' })).statusCode).toBe(401);
    expect(
      (
        await secured.inject({
          method: 'GET',
          url: '/cards',
          headers: { 'X-Admin-Token': 'wrong' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await secured.inject({
          method: 'GET',
          url: '/cards',
          headers: { 'X-Admin-Token': ADMIN_TOKEN },
        })
      ).statusCode,
    ).toBe(200);
  });
});
