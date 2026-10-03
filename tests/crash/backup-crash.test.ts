import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * 热备崩溃续传（T-M10-04，G-M10「热备崩溃续传用例绿」，设计 §5.2 / ADR-3-04）。
 *
 * 注入点：游标落盘前 SIGKILL（AIDLE_TEST_CRASH_AT=1，写计数构成见 backup-harness.mjs 头注）。
 * 复现场景：本轮 JSONL 增量已追加进备份、但游标未更新——即「备份超前于游标」。
 * 恢复轮以游标 offset 为准截断备份后重追加，最终备份与源逐字节一致（续传幂等）。
 */

const HARNESS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'backup-harness.mjs');

const created: string[] = [];

interface HarnessRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

function runHarness(args: string[], env: Record<string, string> = {}): Promise<HarnessRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HARNESS, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stderr }));
  });
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

describe('热备崩溃续传（游标前 kill -9 → 重启后续传收敛）', () => {
  it('备份超前于游标的崩溃现场被下一轮修正，备份与源逐字节一致', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'bv-backup-crash-'));
    created.push(root);
    const dataDir = path.join(root, 'data');
    const backupDir = path.join(root, 'backup');
    const messagesRel = 'rooms/r1/sessions/s1/messages.jsonl';

    // ---- 阶段一：正常同步一轮（游标记下 offset）----
    await seed(
      dataDir,
      messagesRel,
      `${Array.from({ length: 20 }, (_, i) => `line-${i}`).join('\n')}\n`,
    );
    await seed(dataDir, 'rooms/r1/room.json', '{"schemaVersion":1,"v":1}');
    const first = await runHarness([dataDir, backupDir]);
    expect(first.code, `首轮同步应正常退出：${first.stderr}`).toBe(0);
    expect(first.stderr).toContain('[harness] done');
    await expectMirrored(dataDir, backupDir, messagesRel);

    // ---- 阶段二：源增长 + 小文件变更，本轮死于游标落盘前 ----
    await appendFile(
      path.join(dataDir, messagesRel),
      `${Array.from({ length: 30 }, (_, i) => `new-${i}`).join('\n')}\n`,
      'utf8',
    );
    await seed(dataDir, 'rooms/r1/room.json', '{"schemaVersion":1,"v":2}');

    const crashed = await runHarness([dataDir, backupDir], { AIDLE_TEST_CRASH_AT: '1' });
    expect(
      crashed.signal !== null || crashed.code !== 0,
      `子进程未被强制终止（code=${crashed.code} signal=${crashed.signal} stderr=${crashed.stderr}）`,
    ).toBe(true);
    expect(crashed.stderr).not.toContain('[harness] done');

    // 崩溃现场：JSONL 备份已追加（超前于游标），游标仍是阶段一状态
    const cursor = JSON.parse(
      await readFile(path.join(dataDir, 'index', 'backup-cursor.json'), 'utf8'),
    ) as Record<string, { offset: number }>;
    const sourceSize = (await readFile(path.join(dataDir, messagesRel))).length;
    const backupSize = (await readFile(path.join(backupDir, messagesRel))).length;
    expect(cursor[messagesRel]?.offset, '游标应停在阶段一').toBeLessThan(sourceSize);
    expect(backupSize, '崩溃前本轮增量应已写入备份').toBe(sourceSize);

    // ---- 阶段三：重启后续传，备份收敛到与源逐字节一致 ----
    const resumed = await runHarness([dataDir, backupDir]);
    expect(resumed.code, `恢复轮应正常退出：${resumed.stderr}`).toBe(0);
    await expectMirrored(dataDir, backupDir, messagesRel);
    await expectMirrored(dataDir, backupDir, 'rooms/r1/room.json');

    // 游标收敛：messages offset == 源大小
    const cursorAfter = JSON.parse(
      await readFile(path.join(dataDir, 'index', 'backup-cursor.json'), 'utf8'),
    ) as Record<string, { offset: number }>;
    expect(cursorAfter[messagesRel]?.offset).toBe(sourceSize);
  }, 30_000);
});
