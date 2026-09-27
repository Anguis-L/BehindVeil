import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataLayout, type DataLayout } from '../../adapters/storage/layout.js';
import { createRoom } from '../session/rooms.js';
import { createSession, endSession } from '../session/sessions.js';
import { loadModule, listModules, unloadModule } from './library.js';

/**
 * T-M5-05：模组包仓库。加载 = 校验（TC-FR-10-001），卸载按 D-09（活跃引用拒绝），
 * 文件系统即真相（无登记表，坏包视为不存在）。
 */

const created: string[] = [];
let layout: DataLayout;

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

const KP_CARD = {
  spec: 'chara_card_v3',
  data: {
    name: '守秘人',
    description: '只叙述，不宣告判定。',
    scenario: '疯狂山脉',
    first_mes: '风雪停了。',
    mes_example: '',
    extensions: { aidle: { rulebook: 'coc7' } },
  },
};

/** 写一个完整/残缺的模组包目录；over.id 用于测试 id 与目录名不一致的分支 */
async function writeModule(
  dirName: string,
  opts: { id?: string; apiVersion?: string; omit?: Array<'kp' | 'wb' | 'state'> } = {},
): Promise<void> {
  const dir = path.join(layout.modulesDir, dirName);
  await mkdir(dir, { recursive: true });
  const manifest = {
    id: opts.id ?? dirName,
    name: '疯狂山脉',
    version: '1.0.0',
    rulebook: 'coc7',
    apiVersion: opts.apiVersion ?? '1',
    entry: { kpCard: 'kp-card.json', worldBook: 'worldbook.json', initState: 'init-state.json' },
  };
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  if (!opts.omit?.includes('kp')) {
    await writeFile(path.join(dir, 'kp-card.json'), JSON.stringify(KP_CARD));
  }
  if (!opts.omit?.includes('wb')) {
    await writeFile(path.join(dir, 'worldbook.json'), JSON.stringify({ entries: [] }));
  }
  if (!opts.omit?.includes('state')) {
    await writeFile(
      path.join(dir, 'init-state.json'),
      JSON.stringify({
        scene: { name: '营地', time: '1931 年南极夏', publicDesc: '风雪刚停。' },
        facts: ['营地补给只够三天'],
        opening: '以无线电杂音开场。',
      }),
    );
  }
}

beforeAll(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bv-modules-'));
  created.push(dir);
  layout = createDataLayout(dir);
  await writeModule('mountains');
  await writeModule('bad-manifest', { apiVersion: '9' });
  await writeModule('mismatch', { id: 'other' });
  await writeModule('no-kp', { omit: ['kp'] });
  await writeModule('no-wb', { omit: ['wb'] });
  await writeModule('no-state', { omit: ['state'] });
});

afterAll(async () => {
  await Promise.all(created.splice(0).map((d) => rm(d, { recursive: true, force: true })));
}, 120_000);

describe('loadModule（T-M5-05，TC-FR-10-001）', () => {
  it('完整包装载：manifest + 三件套全部解析通过', async () => {
    const result = await loadModule(layout, 'mountains');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.module.manifest).toMatchObject({
      id: 'mountains',
      name: '疯狂山脉',
      rulebook: 'coc7',
      apiVersion: '1',
    });
    expect(result.module.kpCard.data.name).toBe('守秘人');
    expect(result.module.initState.scene.name).toBe('营地');
    expect(result.module.initState.opening).toBe('以无线电杂音开场。');
  });

  it('apiVersion 不符 → manifest 校验拒绝', async () => {
    const result = await loadModule(layout, 'bad-manifest');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('manifest');
  });

  it('manifest.id 与目录名不一致 → 拒绝', async () => {
    const result = await loadModule(layout, 'mismatch');
    expect(result).toMatchObject({ ok: false, reason: 'manifest' });
  });

  it.each([
    ['缺 KP 卡', 'no-kp', 'entry'],
    ['世界书坏', 'no-wb', 'entry'],
    ['init-state 坏', 'no-state', 'entry'],
  ])('%s → entry 拒绝', async (_name, dirName, reason) => {
    const result = await loadModule(layout, dirName);
    expect(result).toMatchObject({ ok: false, reason });
  });

  it('目录不存在 → not-found；路径穿越 → path 拒绝', async () => {
    expect(await loadModule(layout, 'ghost')).toMatchObject({ ok: false, reason: 'not-found' });
    expect(await loadModule(layout, '../rooms')).toMatchObject({ ok: false, reason: 'path' });
    expect(await loadModule(layout, 'a/b')).toMatchObject({ ok: false, reason: 'path' });
  });
});

describe('listModules / unloadModule（D-09）', () => {
  it('listModules 扫描现读：坏包视为不存在，好的带引用计数', async () => {
    const modules = await listModules(layout);
    const ids = modules.map((m) => m.id);
    expect(ids).toContain('mountains');
    expect(ids).not.toContain('bad-manifest');
    expect(ids).not.toContain('no-kp');
    expect(modules.find((m) => m.id === 'mountains')).toMatchObject({
      name: '疯狂山脉',
      activeSessions: 0,
    });
  });

  it('活跃会话引用中 → 卸载拒绝（E-MOD-01 语义）；无引用 → 目录移除', async () => {
    // 引用中：开一团 moduleRef=mountains
    const room = await createRoom(layout, { name: '模组房' });
    const session = await createSession(layout, room.id, { moduleId: 'mountains', settings });
    const busy = await unloadModule(layout, 'mountains');
    expect(busy).toMatchObject({ ok: false, reason: 'in-use', message: '模组使用中，无法卸载' });

    // 结束会话后引用清零 → 卸载成功且目录消失
    await endSession(layout, room.id, session.id);
    const free = await unloadModule(layout, 'mountains');
    expect(free).toMatchObject({ ok: true });
    expect(await loadModule(layout, 'mountains')).toMatchObject({ ok: false, reason: 'not-found' });
  });

  it('卸载不存在的模组 → not-found', async () => {
    expect(await unloadModule(layout, 'ghost')).toMatchObject({ ok: false, reason: 'not-found' });
  });
});
