import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createServer } from '../../index.js';
import { createDataLayout } from './layout.js';
import { assertArchivesUpToDate, scanArchiveVersions } from './version-gate.js';

/**
 * 启动版本门禁（T-M10-01，FR-30）：版本不符拒绝启动并明示迁移命令；
 * 损坏 JSON 不归门禁管（启动恢复器辖区，v1/v2 行为不劣化）。
 */

const created: string[] = [];

async function makeDataDir(): Promise<ReturnType<typeof createDataLayout>> {
  const root = await mkdtemp(path.join(tmpdir(), 'bv-version-gate-'));
  created.push(root);
  return createDataLayout(root);
}

async function seed(layout: ReturnType<typeof createDataLayout>, rel: string, raw: string) {
  const file = path.join(layout.root, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, raw, 'utf8');
}

afterAll(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('scanArchiveVersions / assertArchivesUpToDate', () => {
  it('空 data/（首次启动）零存档，静默通过', async () => {
    const layout = await makeDataDir();
    const scan = await scanArchiveVersions(layout.root);
    expect(scan.checked).toBe(0);
    expect(scan.issues).toEqual([]);
    await expect(assertArchivesUpToDate(layout.root)).resolves.toEqual(scan);
  });

  it('全部 v1 存档合规', async () => {
    const layout = await makeDataDir();
    await seed(layout, 'rooms/r1/room.json', JSON.stringify({ schemaVersion: 1, id: 'r1' }));
    await seed(layout, 'rooms/r1/members.json', JSON.stringify({ schemaVersion: 1, members: [] }));
    await seed(layout, 'rooms/r1/sessions/s1/session.json', JSON.stringify({ schemaVersion: 1 }));
    await seed(layout, 'rooms/r1/sessions/s1/state.json', JSON.stringify({ schemaVersion: 1 }));

    const scan = await scanArchiveVersions(layout.root);
    expect(scan.checked).toBe(4);
    expect(scan.issues).toEqual([]);
  });

  it('版本不详（v2.0 存量，无 schemaVersion）→ 问题清单含文件与期望版本', async () => {
    const layout = await makeDataDir();
    await seed(layout, 'rooms/r1/room.json', JSON.stringify({ id: 'r1' }));

    const scan = await scanArchiveVersions(layout.root);
    expect(scan.issues).toEqual([
      { relativePath: 'rooms/r1/room.json', kind: 'room', found: 0, expected: 1 },
    ]);
  });

  it('版本字段非法 → found=invalid；超前版本 → found=2', async () => {
    const layout = await makeDataDir();
    await seed(layout, 'rooms/r1/room.json', JSON.stringify({ schemaVersion: 'x' }));
    await seed(layout, 'rooms/r1/sessions/s1/state.json', JSON.stringify({ schemaVersion: 2 }));

    const scan = await scanArchiveVersions(layout.root);
    expect(scan.issues.map((i) => i.found).sort()).toEqual([2, 'invalid']);
  });

  it('损坏 JSON 不算版本问题（恢复器辖区）；缺失文件不计', async () => {
    const layout = await makeDataDir();
    await seed(layout, 'rooms/r1/room.json', '{ broken');
    await seed(layout, 'rooms/r1/roster.json', JSON.stringify({ schemaVersion: 1 }));

    const scan = await scanArchiveVersions(layout.root);
    expect(scan.checked).toBe(1);
    expect(scan.issues).toEqual([]);
  });

  it('assertArchivesUpToDate 抛 MigrationRequiredError，消息含文件与命令', async () => {
    const layout = await makeDataDir();
    await seed(layout, 'rooms/r1/members.json', JSON.stringify([{ id: 'm1' }]));

    const err = await assertArchivesUpToDate(layout.root).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const message = err instanceof Error ? err.message : '';
    expect(message).toContain('rooms/r1/members.json');
    expect(message).toContain('pnpm aidle-migrate');
  });
});

describe('createServer 启动集成：版本不符拒绝启动', () => {
  it('存在未迁移存档时 createServer 直接拒绝（不进恢复扫描）', async () => {
    const layout = await makeDataDir();
    await seed(layout, 'rooms/r1/room.json', JSON.stringify({ id: 'r1' }));

    await expect(createServer({ dataDir: layout.root, logger: false })).rejects.toThrow(
      /pnpm aidle-migrate/,
    );
  });

  it('合规存档（或空目录）正常启动', async () => {
    const layout = await makeDataDir();
    await seed(layout, 'rooms/r1/room.json', JSON.stringify({ schemaVersion: 1, id: 'r1' }));

    const app = await createServer({ dataDir: layout.root, logger: false });
    await app.close();
  });
});
