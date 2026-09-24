import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { recover } from './recovery.js';

/**
 * T-M0-04：启动恢复器（TDD §6 / NFR-06）。
 * 扫描 data/rooms/ → 重建房间与会话元数据 → JSONL 坏行跳过并告警。
 */

const created: string[] = [];

async function makeDataDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'bv-recover-'));
  created.push(dir);
  return dir;
}

const roomJson = {
  id: 'room_1',
  name: '深夜书房',
  createdAt: '2026-09-25T00:00:00.000Z',
  inviteCode: 'A1B2C3',
  activeSessionId: 'ses_1',
  memberLimit: 8,
};

const sessionJson = {
  id: 'ses_1',
  roomId: 'room_1',
  moduleRef: 'module_demo@1.0.0',
  startedAt: '2026-09-25T00:00:00.000Z',
  endedAt: null,
  stateBoardVersion: 1,
  settings: {
    provider: 'openai-compat',
    model: 'deepseek-chat',
    temperature: 0.8,
    maxHistoryMessages: 40,
    worldBookBudgetTokens: 2000,
    scanDepth: 4,
  },
};

async function seedRoom(
  dataDir: string,
  opts: { messages?: string[]; withSessionJson?: boolean } = {},
): Promise<void> {
  const roomDir = path.join(dataDir, 'rooms', 'room_1');
  const sessionDir = path.join(roomDir, 'sessions', 'ses_1');
  await mkdir(sessionDir, { recursive: true });
  await writeFile(path.join(roomDir, 'room.json'), JSON.stringify(roomJson), 'utf8');
  await writeFile(path.join(roomDir, 'members.json'), JSON.stringify([]), 'utf8');

  if (opts.withSessionJson !== false) {
    await writeFile(path.join(sessionDir, 'session.json'), JSON.stringify(sessionJson), 'utf8');
  }
  const lines = opts.messages ?? [];
  if (lines.length > 0) {
    await writeFile(path.join(sessionDir, 'messages.jsonl'), lines.join('\n') + '\n', 'utf8');
  }
}

const msg = (seq: number): string =>
  JSON.stringify({
    seq,
    ts: '2026-09-25T00:00:00.000Z',
    sessionId: 'ses_1',
    type: 'ic',
    senderId: 'm1',
    content: `第 ${seq} 条`,
  });

afterAll(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('recover 正常路径', () => {
  it('恢复房间与会话元数据', async () => {
    const dataDir = await makeDataDir();
    await seedRoom(dataDir, { messages: [msg(1), msg(2), msg(3)] });

    const result = await recover(dataDir);

    expect(result).toMatchObject({
      rooms: [{ id: 'room_1' }],
      sessions: [{ session: { id: 'ses_1' }, messageCount: 3 }],
      badLines: 0,
    });
    expect(result.warnings).toEqual([]);
  });

  it('无消息文件的会话也恢复（刚开团）', async () => {
    const dataDir = await makeDataDir();
    await seedRoom(dataDir);

    const result = await recover(dataDir);

    expect(result).toMatchObject({ sessions: [{ session: { id: 'ses_1' }, messageCount: 0 }] });
  });
});

describe('recover 坏行容错（NFR-06）', () => {
  it('跳过坏行并计入告警，正常消息不丢', async () => {
    const dataDir = await makeDataDir();
    await seedRoom(dataDir, { messages: [msg(1), '{"seq":2', 'garbage', msg(3)] });

    const result = await recover(dataDir);

    expect(result.badLines).toBe(2);
    expect(result).toMatchObject({ sessions: [{ session: { id: 'ses_1' }, messageCount: 2 }] });
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('session.json 缺失时仍能重建会话并告警（元数据重建）', async () => {
    const dataDir = await makeDataDir();
    await seedRoom(dataDir, { messages: [msg(1), msg(2)], withSessionJson: false });

    const result = await recover(dataDir);

    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result).toMatchObject({ sessions: [{ messageCount: 2 }] });
  });

  it('room.json 缺失时不崩溃，产出告警', async () => {
    const dataDir = await makeDataDir();
    await mkdir(path.join(dataDir, 'rooms', 'room_1'), { recursive: true });

    const result = await recover(dataDir);

    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.rooms).toEqual([]);
  });
});

describe('recover 边界', () => {
  it('data 目录不存在时返回空结果而不抛错（首次启动）', async () => {
    const dataDir = await makeDataDir();
    const result = await recover(path.join(dataDir, 'no-such-dir'));

    expect(result.rooms).toEqual([]);
    expect(result.sessions).toEqual([]);
    expect(result.badLines).toBe(0);
  });

  it('空 data 目录返回空结果', async () => {
    const result = await recover(await makeDataDir());

    expect(result).toMatchObject({ badLines: 0 });
    expect(result.rooms).toEqual([]);
    expect(result.sessions).toEqual([]);
  });
});
