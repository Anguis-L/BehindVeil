import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createDataLayout } from '../../adapters/storage/layout.js';
import {
  createRoom,
  findByInviteCode,
  listRoomFiles,
  readRoomFile,
  resetInviteCode,
  toPublicRoom,
  updateRoomSettings,
} from './rooms.js';

/**
 * T-M1-01：Room 仓库（TDD §3.1/§6）。
 * room.json 在 Room 之外多存 hostToken（开放问题①）——toPublicRoom 必须剥离，
 * 这是「凭据不外带」不变式的落点（决议 ①）。
 */

const created: string[] = [];

async function makeLayout() {
  const root = await mkdtemp(path.join(tmpdir(), 'bv-rooms-'));
  created.push(root);
  return createDataLayout(root);
}

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

/** 直接落一个非法 room.json（先建出目录），模拟损坏文件 */
async function seedBrokenRoom(layout: ReturnType<typeof createDataLayout>, roomId: string) {
  const file = layout.roomFile(roomId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '{"nope":1}', 'utf8');
}

afterAll(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('createRoom / toPublicRoom（T-M1-01）', () => {
  it('最小建房：默认 memberLimit=8、inviteCode 6 位、activeSessionId 为空，落盘可读回', async () => {
    const layout = await makeLayout();

    const room = await createRoom(layout, { name: '疯狂山脉·第一夜' });

    expect(room.name).toBe('疯狂山脉·第一夜');
    expect(room.memberLimit).toBe(8);
    expect(room.activeSessionId).toBeNull();
    expect(room.inviteCode).toHaveLength(6);
    expect(room.hostToken.length).toBeGreaterThan(0);
    expect(room.defaultSessionSettings).toBeUndefined();

    const back = await readRoomFile(layout, room.id);
    expect(back?.id).toBe(room.id);
    expect(back?.hostToken).toBe(room.hostToken);
  });

  it('可指定 memberLimit 与 defaultSessionSettings', async () => {
    const layout = await makeLayout();

    const room = await createRoom(layout, {
      name: '黑夜之子',
      memberLimit: 6,
      defaultSessionSettings: settings,
    });

    expect(room.memberLimit).toBe(6);
    expect(room.defaultSessionSettings).toEqual(settings);
  });

  it('toPublicRoom 剥离 hostToken（凭据只随建房响应发放一次）', async () => {
    const layout = await makeLayout();
    const room = await createRoom(layout, { name: 'x' });

    const pub = toPublicRoom(room);

    expect('hostToken' in pub).toBe(false);
    expect(pub.id).toBe(room.id);
  });
});

describe('readRoomFile / listRoomFiles（容错口径：缺失或校验失败一律 null）', () => {
  it('缺失 → null；Schema 校验失败（如空对象）→ null，不抛错', async () => {
    const layout = await makeLayout();
    await seedBrokenRoom(layout, 'broken');

    expect(await readRoomFile(layout, 'missing')).toBeNull();
    expect(await readRoomFile(layout, 'broken')).toBeNull();
  });

  it('roomsDir 不存在时 listRoomFiles 返回空数组', async () => {
    const layout = await makeLayout();
    expect(await listRoomFiles(layout)).toEqual([]);
  });

  it('列出全部房间；损坏房间与非目录条目跳过', async () => {
    const layout = await makeLayout();
    const a = await createRoom(layout, { name: 'A' });
    const b = await createRoom(layout, { name: 'B' });
    await seedBrokenRoom(layout, 'broken');
    await writeFile(path.join(layout.roomsDir, 'stray.txt'), 'not a room', 'utf8');

    const rooms = await listRoomFiles(layout);
    expect(rooms.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
  });
});

describe('findByInviteCode / resetInviteCode（TDD §8：Host 可重置邀请码）', () => {
  it('按邀请码命中房间；未命中返回 null', async () => {
    const layout = await makeLayout();
    const room = await createRoom(layout, { name: 'A' });

    expect((await findByInviteCode(layout, room.inviteCode))?.id).toBe(room.id);
    expect(await findByInviteCode(layout, 'ZZZZZZ')).toBeNull();
  });

  it('重置后旧码失效、新码 6 位且已落盘', async () => {
    const layout = await makeLayout();
    const room = await createRoom(layout, { name: 'A' });
    const old = room.inviteCode;

    const next = await resetInviteCode(layout, room.id);

    expect(next).toHaveLength(6);
    expect(next).not.toBe(old);
    expect((await findByInviteCode(layout, old))?.id).toBeUndefined();
    expect((await findByInviteCode(layout, next as string))?.id).toBe(room.id);
  });

  it('未知房间重置 → null', async () => {
    const layout = await makeLayout();
    expect(await resetInviteCode(layout, 'missing')).toBeNull();
  });
});

describe('updateRoomSettings（openapi RoomSettingsPatch：局部更新）', () => {
  it('patch 指定字段，未传字段保持不变，改动落盘', async () => {
    const layout = await makeLayout();
    const room = await createRoom(layout, {
      name: '旧名',
      memberLimit: 8,
      defaultSessionSettings: settings,
    });

    const updated = await updateRoomSettings(layout, room.id, { name: '新名', memberLimit: 5 });

    expect(updated?.name).toBe('新名');
    expect(updated?.memberLimit).toBe(5);
    expect(updated?.defaultSessionSettings).toEqual(settings);

    const back = await readRoomFile(layout, room.id);
    expect(back?.name).toBe('新名');
  });

  it('可单改 defaultSessionSettings；未知房间 → null', async () => {
    const layout = await makeLayout();
    const room = await createRoom(layout, { name: 'A' });

    const updated = await updateRoomSettings(layout, room.id, { defaultSessionSettings: settings });
    expect(updated?.defaultSessionSettings).toEqual(settings);
    expect(updated?.name).toBe('A');

    expect(await updateRoomSettings(layout, 'missing', { name: 'x' })).toBeNull();
  });
});
