import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createDataLayout } from '../../adapters/storage/layout.js';
import { JsonStore } from '../../adapters/storage/json-store.js';
import { createRoom, readRoomFile } from './rooms.js';
import {
  createSession,
  endSession,
  listSessions,
  readSession,
  setActiveSession,
} from './sessions.js';

/**
 * T-M1-01/07：Session 仓库（TDD §3.1/§6、FR-11 一房多会话）。
 * 开新会话自动结束当前活跃会话；activeSessionId 指向唯一活跃会话。
 */

const created: string[] = [];

async function makeLayout() {
  const root = await mkdtemp(path.join(tmpdir(), 'bv-sessions-'));
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
};

afterAll(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('createSession（T-M1-01/07）', () => {
  it('房间不存在 → 抛错', async () => {
    const layout = await makeLayout();
    await expect(createSession(layout, 'missing', { moduleId: 'mod-1', settings })).rejects.toThrow(
      /房间不存在/,
    );
  });

  it('首次开团：session.json + 初始 state.json 落盘，activeSessionId 指向新会话', async () => {
    const layout = await makeLayout();
    const room = await createRoom(layout, { name: 'A' });

    const session = await createSession(layout, room.id, { moduleId: 'mod-1', settings });

    expect(session.id).toMatch(/^s_/);
    expect(session.roomId).toBe(room.id);
    expect(session.moduleRef).toBe('mod-1');
    expect(session.endedAt).toBeNull();
    expect(session.stateBoardVersion).toBe(0);
    expect(session.settings).toEqual(settings);

    const back = await readSession(layout, room.id, session.id);
    expect(back?.id).toBe(session.id);

    const stateBoard = await new JsonStore(layout.stateFile(room.id, session.id)).read();
    expect(stateBoard).toMatchObject({ version: 0, pcs: {}, facts: [] });

    const roomAfter = await readRoomFile(layout, room.id);
    expect(roomAfter?.activeSessionId).toBe(session.id);
  });

  it('已有活跃会话时开新团：旧会话 endedAt 落今，活跃指针切换', async () => {
    const layout = await makeLayout();
    const room = await createRoom(layout, { name: 'A' });
    const first = await createSession(layout, room.id, { moduleId: 'mod-1', settings });

    const second = await createSession(layout, room.id, { moduleId: 'mod-2', settings });

    const firstAfter = await readSession(layout, room.id, first.id);
    expect(firstAfter?.endedAt).not.toBeNull();
    expect(second.endedAt).toBeNull();

    const roomAfter = await readRoomFile(layout, room.id);
    expect(roomAfter?.activeSessionId).toBe(second.id);
  });
});

describe('readSession / listSessions', () => {
  it('缺失的 session → null', async () => {
    const layout = await makeLayout();
    const room = await createRoom(layout, { name: 'A' });
    expect(await readSession(layout, room.id, 's_missing')).toBeNull();
  });

  it('sessionsDir 不存在（从未开团）→ 空数组', async () => {
    const layout = await makeLayout();
    expect(await listSessions(layout, 'room-1')).toEqual([]);
  });

  it('按 startedAt 升序列出全部会话', async () => {
    const layout = await makeLayout();
    const room = await createRoom(layout, { name: 'A' });
    const a = await createSession(layout, room.id, { moduleId: 'mod-1', settings });
    const b = await createSession(layout, room.id, { moduleId: 'mod-1', settings });

    const sessions = await listSessions(layout, room.id);
    expect(sessions.map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
    // 同毫秒创建时 startedAt 可能相等，只断言非降序
    const started = sessions.map((s) => s.startedAt);
    expect([...started].sort((x, y) => x.localeCompare(y))).toEqual(started);
  });
});

describe('endSession（T-M1-07）/ setActiveSession（FR-11 连载复播）', () => {
  it('结束活跃会话：endedAt 落今且 activeSessionId 清空', async () => {
    const layout = await makeLayout();
    const room = await createRoom(layout, { name: 'A' });
    const session = await createSession(layout, room.id, { moduleId: 'mod-1', settings });

    const ended = await endSession(layout, room.id, session.id);

    expect(ended?.endedAt).not.toBeNull();
    const roomAfter = await readRoomFile(layout, room.id);
    expect(roomAfter?.activeSessionId).toBeNull();
  });

  it('结束非活跃会话：只置 endedAt，不动活跃指针', async () => {
    const layout = await makeLayout();
    const room = await createRoom(layout, { name: 'A' });
    const first = await createSession(layout, room.id, { moduleId: 'mod-1', settings }); // 开新团时被结束
    const second = await createSession(layout, room.id, { moduleId: 'mod-1', settings }); // 当前活跃
    await setActiveSession(layout, room.id, first.id); // 复播旧团：活跃指针挪到 first

    const ended = await endSession(layout, room.id, second.id);

    expect(ended?.endedAt).not.toBeNull();
    const roomAfter = await readRoomFile(layout, room.id);
    expect(roomAfter?.activeSessionId).toBe(first.id);
  });

  it('重复 end 幂等：endedAt 不变', async () => {
    const layout = await makeLayout();
    const room = await createRoom(layout, { name: 'A' });
    const session = await createSession(layout, room.id, { moduleId: 'mod-1', settings });
    const first = await endSession(layout, room.id, session.id);

    const again = await endSession(layout, room.id, session.id);

    expect(again?.endedAt).toBe(first?.endedAt);
  });

  it('未知会话 → null', async () => {
    const layout = await makeLayout();
    const room = await createRoom(layout, { name: 'A' });
    expect(await endSession(layout, room.id, 's_missing')).toBeNull();
  });

  it('切换活跃会话到旧会话（复播）；未知会话 → null', async () => {
    const layout = await makeLayout();
    const room = await createRoom(layout, { name: 'A' });
    const first = await createSession(layout, room.id, { moduleId: 'mod-1', settings });
    await createSession(layout, room.id, { moduleId: 'mod-1', settings }); // 第二团成为活跃

    const switched = await setActiveSession(layout, room.id, first.id);
    expect(switched?.id).toBe(first.id);
    const roomAfter = await readRoomFile(layout, room.id);
    expect(roomAfter?.activeSessionId).toBe(first.id);

    expect(await setActiveSession(layout, room.id, 's_missing')).toBeNull();
  });
});
