import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createDataLayout } from '../adapters/storage/layout.js';
import { runMigrate } from './aidle-migrate.js';

/**
 * aidle-migrate CLI（T-M10-01，G-M10「迁移链用例全绿」）：
 * 校验先于一切写入（损坏/超前版本中止且零副作用）；升级前整目录备份；
 * 自检失败回滚；幂等重跑。
 */

const created: string[] = [];

async function makeDataDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'bv-migrate-'));
  created.push(root);
  return root;
}

async function seed(root: string, rel: string, raw: string): Promise<void> {
  const file = path.join(root, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, raw, 'utf8');
}

async function backupDirs(root: string): Promise<string[]> {
  try {
    return (await readdir(root)).filter((n) => n.startsWith('backup-pre-migrate-'));
  } catch {
    return [];
  }
}

/** 一套 v2.0 形态（版本不详）的完整 COC7 存档 */
async function seedV20Archive(root: string, roomId = 'room-old'): Promise<void> {
  await seed(
    root,
    `rooms/${roomId}/room.json`,
    JSON.stringify({
      id: roomId,
      name: '老团',
      createdAt: '2026-09-01T10:00:00.000Z',
      inviteCode: 'ABC123',
      activeSessionId: 'ses_old',
      memberLimit: 8,
      hostToken: 'ht_secret',
    }),
  );
  await seed(
    root,
    `rooms/${roomId}/members.json`,
    JSON.stringify([
      { id: 'm1', name: 'KP', role: 'host', joinedAt: '2026-09-01T10:00:00.000Z' },
      { id: 'm2', name: '阿珂', role: 'player', joinedAt: '2026-09-01T10:01:00.000Z' },
    ]),
  );
  await seed(root, `rooms/${roomId}/roster.json`, JSON.stringify({ pcs: {} }));
  await seed(
    root,
    `rooms/${roomId}/sessions/ses_old/session.json`,
    JSON.stringify({
      id: 'ses_old',
      roomId,
      moduleRef: 'mod-haunted-house@1.0.0',
      startedAt: '2026-09-01T10:02:00.000Z',
      endedAt: null,
      stateBoardVersion: 3,
      settings: {
        provider: 'openai-compat',
        model: 'deepseek-chat',
        temperature: 0.7,
        maxHistoryMessages: 40,
        worldBookBudgetTokens: 2000,
        scanDepth: 4,
      },
      synopsis: '第一章。',
    }),
  );
  await seed(
    root,
    `rooms/${roomId}/sessions/ses_old/state.json`,
    JSON.stringify({
      version: 3,
      pcs: {
        m2: {
          sheet: {
            rulebook: 'coc7',
            playerName: '阿珂',
            occupation: '侦探',
            str: 50,
            con: 55,
            siz: 45,
            dex: 70,
            app: 60,
            int: 75,
            pow: 65,
            edu: 80,
            luck: 55,
            hp: 10,
            mp: 13,
            san: 55,
            db: '0',
            build: '0',
            skills: { 侦查: 60 },
          },
          conditions: ['轻伤'],
        },
      },
      scene: { name: '书房', time: '1924-03-12 深夜', publicDesc: '烛光摇曳' },
      facts: ['书房的窗户从内侧锁着'],
      updatedAt: '2026-09-01T12:00:00.000Z',
    }),
  );
  await seed(
    root,
    `rooms/${roomId}/sessions/ses_old/messages.jsonl`,
    `${JSON.stringify({ seq: 1, type: 'ic', content: '开门' })}\n${JSON.stringify({ seq: 2, type: 'ic', content: '点灯' })}\n`,
  );
  await seed(root, 'logs/audit-dice.jsonl', `${JSON.stringify({ seq: '000001', total: 55 })}\n`);
}

afterAll(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('runMigrate', () => {
  it('data/ 不存在 → 成功且零动作', async () => {
    const root = await makeDataDir();
    const result = await runMigrate(path.join(root, 'data'));
    expect(result.ok).toBe(true);
    expect(result.lines.join('\n')).toContain('无需迁移');
    expect(result.backupDir).toBeUndefined();
  });

  it('v2.0 存量：升级全部存档 + members 重构 + 整目录备份 + 自检通过', async () => {
    const root = await makeDataDir();
    await seedV20Archive(root);

    const result = await runMigrate(root);
    expect(result.ok, result.lines.join('\n')).toBe(true);
    expect(result.backupDir).toBeDefined();

    // room：payload 原样、版本字段在首
    const roomRaw = JSON.parse(
      await readFile(path.join(root, 'rooms/room-old/room.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(roomRaw['schemaVersion']).toBe(1);
    expect(roomRaw['hostToken']).toBe('ht_secret');

    // members：数组根 → 对象根
    const membersRaw = JSON.parse(
      await readFile(path.join(root, 'rooms/room-old/members.json'), 'utf8'),
    ) as { schemaVersion: number; members: unknown[] };
    expect(membersRaw.schemaVersion).toBe(1);
    expect(membersRaw.members).toHaveLength(2);

    // session / state payload 完整保留
    const state = JSON.parse(
      await readFile(path.join(root, 'rooms/room-old/sessions/ses_old/state.json'), 'utf8'),
    ) as { schemaVersion: number; pcs: Record<string, unknown> };
    expect(state.schemaVersion).toBe(1);
    expect(Object.keys(state.pcs)).toEqual(['m2']);

    // JSONL 不迁移，内容原样
    const messages = await readFile(
      path.join(root, 'rooms/room-old/sessions/ses_old/messages.jsonl'),
      'utf8',
    );
    expect(messages).not.toContain('schemaVersion');
    expect(messages.split('\n')).toHaveLength(3); // 两行 + 尾空行

    // 备份目录保存 v2.0 原貌（版本不详）
    const backups = await backupDirs(root);
    expect(backups).toHaveLength(1);
    const backupRoom = JSON.parse(
      await readFile(path.join(root, backups[0] ?? '', 'rooms/room-old/room.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(backupRoom['schemaVersion']).toBeUndefined();
    expect(backupRoom['hostToken']).toBe('ht_secret');

    // 自检报告包含 JSONL 解析行（messages 2 条 + audit-dice 1 条）
    expect(result.lines.join('\n')).toMatch(/JSONL 解析 3 条记录，坏行 0 条/);
  });

  it('幂等：迁移后重跑 → 无需迁移，不产生新备份', async () => {
    const root = await makeDataDir();
    await seedV20Archive(root);
    await runMigrate(root);

    const result = await runMigrate(root);
    expect(result.ok).toBe(true);
    expect(result.lines.join('\n')).toContain('无需迁移');
    expect(await backupDirs(root)).toHaveLength(1);
  });

  it('损坏 JSON：校验阶段中止，零副作用（无备份、文件原样）', async () => {
    const root = await makeDataDir();
    await seed(root, 'rooms/r1/room.json', '{ broken');

    const result = await runMigrate(root);
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toContain('不是合法 JSON');
    expect(await backupDirs(root)).toEqual([]);
    expect(await readFile(path.join(root, 'rooms/r1/room.json'), 'utf8')).toBe('{ broken');
  });

  it('超前版本：拒绝降级，零副作用', async () => {
    const root = await makeDataDir();
    await seed(root, 'rooms/r1/room.json', JSON.stringify({ schemaVersion: 99, id: 'r1' }));

    const result = await runMigrate(root);
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toContain('超前');
    expect(await backupDirs(root)).toEqual([]);
  });

  it('自检失败 → 自动回滚到 v2.0 原貌（文件逐字节还原）', async () => {
    const root = await makeDataDir();
    // payload 不是合法 Room：升级能盖版本字段，但自检过不了 RoomFileSchema
    const original = JSON.stringify({ nonsense: true });
    await seed(root, 'rooms/r1/room.json', original);

    const result = await runMigrate(root);
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toContain('自检失败');
    expect(result.lines.join('\n')).toContain('已从');

    // 回滚后恢复为升级前内容（版本不详）
    expect(await readFile(path.join(root, 'rooms/r1/room.json'), 'utf8')).toBe(original);
    expect(await backupDirs(root)).toHaveLength(1);
  });

  it('混合存量：v2.0 旧件与 v1 新件并存，只升级旧件', async () => {
    const root = await makeDataDir();
    await seedV20Archive(root, 'room-old');
    await seed(
      root,
      'rooms/room-new/room.json',
      JSON.stringify({
        schemaVersion: 1,
        id: 'room-new',
        name: '新团',
        createdAt: '2026-10-03T10:00:00.000Z',
        inviteCode: 'XYZ789',
        activeSessionId: null,
        memberLimit: 8,
        hostToken: 'ht_new',
      }),
    );

    const result = await runMigrate(root);
    expect(result.ok, result.lines.join('\n')).toBe(true);
    expect(result.lines.join('\n')).toContain('另有 1 个已是当前版本');

    const layout = createDataLayout(root);
    const newRoom = JSON.parse(await readFile(layout.roomFile('room-new'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(newRoom['schemaVersion']).toBe(1);
  });
});
