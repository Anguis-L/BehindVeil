import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '@behindveil/shared';
import { ArchiveJsonStore, ArchiveVersionError } from './archive-store.js';
import { createDataLayout } from './layout.js';

/**
 * 带版本的存档存储（T-M10-01）：写自动盖版本信封、读剥离信封；
 * 版本不符（存量未迁移 / 超前）抛 ArchiveVersionError——宁可拒绝，不静默猜。
 */

const created: string[] = [];

async function makeStore(
  kind: 'room' | 'members',
): Promise<{ store: ArchiveJsonStore; file: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'bv-archive-store-'));
  created.push(root);
  const layout = createDataLayout(root);
  const file = kind === 'members' ? layout.membersFile('r1') : layout.roomFile('r1');
  return { store: new ArchiveJsonStore(file, kind), file };
}

/** 手工落盘历史文件（目录先建出） */
async function seedRaw(file: string, raw: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(raw), 'utf8');
}

afterAll(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('写路径：自动盖 schemaVersion 首字段', () => {
  it('对象根 payload → { schemaVersion, ...payload }，版本字段在首', async () => {
    const { store, file } = await makeStore('room');
    await store.write({ id: 'r1', name: '团' });

    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(raw)[0]).toBe('schemaVersion');
    expect(raw['schemaVersion']).toBe(SCHEMA_VERSION);
    expect(raw['id']).toBe('r1');
    expect(raw['name']).toBe('团');
  });

  it('members 数组 payload → { schemaVersion, members }（数组根无法内联字段）', async () => {
    const { store, file } = await makeStore('members');
    const member = { id: 'm1', name: 'KP', role: 'host', joinedAt: 't0' };
    await store.write([member]);

    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    expect(raw['schemaVersion']).toBe(SCHEMA_VERSION);
    expect(raw['members']).toEqual([member]);
  });

  it('非对象/非数组 payload 拒绝写', async () => {
    const room = await makeStore('room');
    await expect(room.store.write([1, 2])).rejects.toThrow(/对象根/);
    const members = await makeStore('members');
    await expect(members.store.write({ nope: true })).rejects.toThrow(/数组/);
  });
});

describe('读路径：剥信封 + 版本门', () => {
  it('写后读回裸 payload（与 v2 领域类型一致）', async () => {
    const { store } = await makeStore('room');
    await store.write({ id: 'r1', name: '团' });
    expect(await store.read()).toEqual({ id: 'r1', name: '团' });

    const members = await makeStore('members');
    const roster = [{ id: 'm1', name: 'KP', role: 'host', joinedAt: 't0' }];
    await members.store.write(roster);
    expect(await members.store.read()).toEqual(roster);
  });

  it('文件不存在 → null', async () => {
    const { store } = await makeStore('room');
    expect(await store.read()).toBeNull();
  });

  it('版本不详（v2.0 存量）→ ArchiveVersionError，指明迁移命令', async () => {
    const { store, file } = await makeStore('room');
    await seedRaw(file, { id: 'r1' });

    const err = await store.read().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArchiveVersionError);
    if (err instanceof ArchiveVersionError) {
      expect(err.found).toBe(0);
      expect(err.message).toContain('pnpm aidle-migrate');
    }
  });

  it('超前版本 → 拒绝降级打开', async () => {
    const { store, file } = await makeStore('room');
    await seedRaw(file, { schemaVersion: SCHEMA_VERSION + 1 });
    await expect(store.read()).rejects.toThrow(/超前/);
  });

  it('版本字段非法 → 拒绝', async () => {
    const { store, file } = await makeStore('room');
    await seedRaw(file, { schemaVersion: 'x' });
    await expect(store.read()).rejects.toThrow(/非法/);
  });
});

describe('update：读改写关锁，payload 进出均为裸形态', () => {
  it('mutate 收到裸 payload，返回值落盘后再读回仍裸', async () => {
    const { store } = await makeStore('room');
    await store.write({ id: 'r1', counter: 1 });

    const seen = await store.update((current) => {
      const doc = current as { id: string; counter: number } | null;
      expect(doc?.id).toBe('r1');
      return { id: doc?.id ?? '', counter: (doc?.counter ?? 0) + 1 };
    });
    expect(seen).toEqual({ id: 'r1', counter: 2 });
    expect(await store.read()).toEqual({ id: 'r1', counter: 2 });
  });

  it('update 在缺失文件上从 null 起步', async () => {
    const { store } = await makeStore('room');
    const next = await store.update((current) => ({ existed: current !== null }));
    expect(next).toEqual({ existed: false });
  });
});
