import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataLayout, type DataLayout } from '../../adapters/storage/layout.js';
import { createRoom } from '../../domain/session/rooms.js';
import { createSession } from '../../domain/session/sessions.js';
import { registerModuleRoutes } from './modules.js';

/**
 * T-M5-05：模组管理 REST（/modules 提案端点）。装载 = 校验（400 E-MOD-01），
 * 卸载 D-09（引用中 409）；open + secured 双实例对拍门禁（cards.test.ts 同款）。
 */

const created: string[] = [];
let layout: DataLayout;
let app: FastifyInstance;
let secured: FastifyInstance;
const ADMIN_TOKEN = 'secret-admin-321';

const settings = {
  provider: 'openai-compat',
  model: 'mock',
  temperature: 0.7,
  maxHistoryMessages: 40,
  worldBookBudgetTokens: 2000,
  scanDepth: 4,
  contextWindowTokens: 32_768,
  outputReserveTokens: 2_048,
};

async function writeModule(dirName: string): Promise<void> {
  const dir = path.join(layout.modulesDir, dirName);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      id: dirName,
      name: '疯狂山脉',
      version: '1.0.0',
      rulebook: 'coc7',
      apiVersion: '1',
      entry: { kpCard: 'kp-card.json', worldBook: 'worldbook.json', initState: 'init-state.json' },
    }),
  );
  await writeFile(
    path.join(dir, 'kp-card.json'),
    JSON.stringify({
      spec: 'chara_card_v3',
      data: {
        name: '守秘人',
        description: '只叙述，不宣告判定。',
        scenario: '',
        first_mes: '',
        mes_example: '',
        extensions: { aidle: { rulebook: 'coc7' } },
      },
    }),
  );
  await writeFile(path.join(dir, 'worldbook.json'), JSON.stringify({ entries: [] }));
  await writeFile(
    path.join(dir, 'init-state.json'),
    JSON.stringify({ scene: { name: '营地', time: '1931 年', publicDesc: '风雪刚停。' } }),
  );
}

beforeAll(async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'bv-http-modules-'));
  created.push(dataDir);
  layout = createDataLayout(dataDir);

  app = Fastify({ logger: false });
  registerModuleRoutes(app, { layout, adminToken: undefined });
  await app.ready();

  secured = Fastify({ logger: false });
  registerModuleRoutes(secured, { layout, adminToken: ADMIN_TOKEN });
  await secured.ready();

  await writeModule('mountains');
  await writeModule('broken');
  await writeFile(path.join(layout.modulesDir, 'broken', 'kp-card.json'), '坏 JSON');
});

afterAll(async () => {
  await Promise.all([app.close(), secured.close()]);
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}, 120_000);

describe('GET /modules', () => {
  it('列出校验通过的模组（坏包跳过）', async () => {
    const res = await app.inject({ method: 'GET', url: '/modules' });
    expect(res.statusCode).toBe(200);
    const modules = res.json() as Array<{ id: string; activeSessions: number }>;
    expect(modules.map((m) => m.id)).toContain('mountains');
    expect(modules.map((m) => m.id)).not.toContain('broken');
  });
});

describe('POST /modules', () => {
  it('装载合法包 → 201 ModuleInfo', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/modules',
      payload: { moduleId: 'mountains' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      id: 'mountains',
      name: '疯狂山脉',
      rulebook: 'coc7',
      apiVersion: '1',
      activeSessions: 0,
    });
  });

  it('校验不通过 → 400 E-MOD-01（拒绝装载、不动盘）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/modules',
      payload: { moduleId: 'broken' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'E-MOD-01' });
  });

  it('未知模组 → 400；body 非法 → 400', async () => {
    const missing = await app.inject({
      method: 'POST',
      url: '/modules',
      payload: { moduleId: 'ghost' },
    });
    expect(missing.statusCode).toBe(400);
    const bad = await app.inject({ method: 'POST', url: '/modules', payload: {} });
    expect(bad.statusCode).toBe(400);
  });
});

describe('DELETE /modules/:moduleId（D-09）', () => {
  it('活跃会话引用中 → 409 E-MOD-01', async () => {
    const room = await createRoom(layout, { name: '模组房' });
    await createSession(layout, room.id, { moduleId: 'mountains', settings });
    const res = await app.inject({ method: 'DELETE', url: '/modules/mountains' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'E-MOD-01', message: '模组使用中，无法卸载' });
  });

  it('空闲 → 204 且目录移除；再删 → 404', async () => {
    await writeModule('lonely');
    const res = await app.inject({ method: 'DELETE', url: '/modules/lonely' });
    expect(res.statusCode).toBe(204);
    const again = await app.inject({ method: 'DELETE', url: '/modules/lonely' });
    expect(again.statusCode).toBe(404);
    expect(again.json()).toMatchObject({ code: 'E-MOD-01' });
  });
});

describe('管理面门禁（决议 ②）', () => {
  it('设置令牌后无头 → 401', async () => {
    const res = await secured.inject({ method: 'GET', url: '/modules' });
    expect(res.statusCode).toBe(401);
  });
});
