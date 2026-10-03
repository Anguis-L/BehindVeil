import { mkdtemp, readFile, rm, appendFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createDataLayout } from '../storage/layout.js';
import { BackupSyncer } from './syncer.js';

/**
 * 热备增量同步器（T-M10-02，FR-31 / ADR-3-04）：
 * 初次整份镜像 → 增量偏移续传 / hash 变更整份复制 → 无变化零复制 → 删除镜像。
 * 崩溃续传（kill -9）走 tests/crash/backup-crash.test.ts 子进程注入。
 */

const created: string[] = [];

interface Fixture {
  dataDir: string;
  backupDir: string;
  syncer: BackupSyncer;
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'bv-backup-'));
  created.push(root);
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backup');
  const layout = createDataLayout(dataDir);
  return { dataDir, backupDir, syncer: new BackupSyncer({ dataDir, backupDir, layout }) };
}

async function seed(root: string, rel: string, raw: string): Promise<void> {
  const file = path.join(root, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, raw, 'utf8');
}

async function expectMirrored(dataDir: string, backupDir: string, rel: string): Promise<void> {
  const [src, bak] = await Promise.all([
    readFile(path.join(dataDir, rel)),
    readFile(path.join(backupDir, rel)),
  ]);
  expect(bak.equals(src), `${rel} 备份与源不一致`).toBe(true);
}

afterAll(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('BackupSyncer.syncOnce', () => {
  it('初次同步整份镜像（JSONL + 小文件），游标落盘', async () => {
    const fx = await makeFixture();
    await seed(fx.dataDir, 'rooms/r1/room.json', '{"schemaVersion":1,"id":"r1"}');
    await seed(fx.dataDir, 'rooms/r1/sessions/s1/messages.jsonl', 'line-1\nline-2\n');
    await seed(fx.dataDir, 'config.yaml', 'port: 8787\n');

    const report = await fx.syncer.syncOnce();

    expect(report.scanned).toBe(3);
    expect(report.copied).toBe(3);
    expect(report.appended).toBe(0);
    await expectMirrored(fx.dataDir, fx.backupDir, 'rooms/r1/room.json');
    await expectMirrored(fx.dataDir, fx.backupDir, 'rooms/r1/sessions/s1/messages.jsonl');
    await expectMirrored(fx.dataDir, fx.backupDir, 'config.yaml');

    const cursor = JSON.parse(
      await readFile(path.join(fx.dataDir, 'index/backup-cursor.json'), 'utf8'),
    ) as Record<string, { offset: number }>;
    expect(cursor['rooms/r1/sessions/s1/messages.jsonl']?.offset).toBe(14); // 'line-1\nline-2\n'
  });

  it('JSONL 增长 → 只追加增量字节；无变化 → skipped 零复制', async () => {
    const fx = await makeFixture();
    const messagesRel = 'rooms/r1/sessions/s1/messages.jsonl';
    await seed(fx.dataDir, messagesRel, 'a\n');
    await fx.syncer.syncOnce();

    await appendFile(path.join(fx.dataDir, messagesRel), 'bb\nccc\n', 'utf8'); // +7 字节
    const grow = await fx.syncer.syncOnce();
    expect(grow.appended).toBe(1);
    expect(grow.bytesAppended).toBe(7);
    expect(grow.copied).toBe(0);
    await expectMirrored(fx.dataDir, fx.backupDir, messagesRel);

    const steady = await fx.syncer.syncOnce();
    expect(steady.appended).toBe(0);
    expect(steady.copied).toBe(0);
    expect(steady.skipped).toBe(1);
  });

  it('小文件内容变更 → hash 比对后整份复制；mtime+size 不变 → 跳过', async () => {
    const fx = await makeFixture();
    const roomRel = 'rooms/r1/room.json';
    await seed(fx.dataDir, roomRel, '{"schemaVersion":1,"v":1}');
    await fx.syncer.syncOnce();

    await seed(fx.dataDir, roomRel, '{"schemaVersion":1,"v":2}');
    const updated = await fx.syncer.syncOnce();
    expect(updated.copied).toBe(1);
    await expectMirrored(fx.dataDir, fx.backupDir, roomRel);

    // mtime 同精度下重写同内容：hash 一致 → 不复制
    await writeFile(path.join(fx.dataDir, roomRel), '{"schemaVersion":1,"v":2}', 'utf8');
    const steady = await fx.syncer.syncOnce();
    expect(steady.copied).toBe(0);
  });

  it('源删除 → 备份镜像删除', async () => {
    const fx = await makeFixture();
    await seed(fx.dataDir, 'rooms/r1/room.json', '{"schemaVersion":1}');
    await fx.syncer.syncOnce();

    await rm(path.join(fx.dataDir, 'rooms/r1/room.json'));
    const report = await fx.syncer.syncOnce();
    expect(report.removed).toBe(1);
    await expect(readFile(path.join(fx.backupDir, 'rooms/r1/room.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('data/index/ 与历史迁移备份不进备份范围', async () => {
    const fx = await makeFixture();
    await seed(fx.dataDir, 'rooms/r1/room.json', '{"schemaVersion":1}');
    await seed(fx.dataDir, 'backup-pre-migrate-x/stuff.txt', 'old backup');
    await fx.syncer.syncOnce(); // 生成游标于 data/index/

    const report = await fx.syncer.syncOnce();
    expect(report.scanned).toBe(1); // 仅 room.json；游标与迁移备份不入列
  });

  it('备份目录位于 data/ 内部 → 构造即拒绝', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'bv-backup-nested-'));
    created.push(root);
    const dataDir = path.join(root, 'data');
    const layout = createDataLayout(dataDir);
    expect(
      () => new BackupSyncer({ dataDir, backupDir: path.join(dataDir, 'backup'), layout }),
    ).toThrow(/不能位于 data\/ 内部/);
  });
});
