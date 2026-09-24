import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { JsonlStore } from './jsonl-store.js';
import { JsonStore } from './json-store.js';

/**
 * 崩溃恢复集成测试（NFR-06 / 测试文档 §12.5）。
 *
 * TC-NFR-06-001：追加过程中被 kill -9 → 重启后已确认消息 0 丢失、无残缺行。
 * TC-NFR-06-003：JSON 原子写在 rename 前被 kill -9 → 旧文件完好，无半文件。
 *
 * 崩溃由子进程执行（见 tests/crash/append-harness.mjs），父进程负责校验恢复结果。
 */

const HARNESS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../tests/crash/append-harness.mjs',
);

const created: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'bv-crash-'));
  created.push(dir);
  return dir;
}

interface HarnessRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

function runHarness(args: string[], env: Record<string, string>): Promise<HarnessRun> {
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

afterAll(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('TC-NFR-06-001：追加中崩溃，重启 0 丢失', () => {
  it('第 137 条写后 SIGKILL：前 137 条完整可读且无残缺行', async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, 'messages.jsonl');

    const run = await runHarness(['jsonl', file, '500'], { AIDLE_TEST_CRASH_AT: '137' });

    // 平台无关的终止判据：Windows 上 process.kill(self,'SIGKILL') 走 TerminateProcess，
    // spawn 的 close 事件 signal 恒为 null（实测 exit code=1），断言 signal==='SIGKILL' 在 win32 不可能通过。
    // 改为「非正常退出 + 未打印跑完标记」，既能验出崩溃，也能验出钩子未实现（钩子缺失会跑到 500 条并正常退出）。
    expect(
      run.signal !== null || run.code !== 0,
      `子进程未被强制终止（code=${run.code} signal=${run.signal} stderr=${run.stderr}）`,
    ).toBe(true);
    expect(run.stderr).not.toContain('[harness] done');

    const raw = await readFile(file, 'utf8');
    const lines = raw.split('\n');
    expect(lines.at(-1), '文件必须以完整行收尾，不得出现半行').toBe('');
    expect(lines.filter(Boolean)).toHaveLength(137);
    for (const line of lines.filter(Boolean)) {
      expect(() => JSON.parse(line)).not.toThrow();
    }

    // 重启恢复：用存储层回读（等价于启动扫描）
    const result = await new JsonlStore(file).readAll();
    expect(result.badLines).toBe(0);
    expect(result.records).toHaveLength(137);
    expect(result.records[0]).toMatchObject({ seq: 1 });
    expect(result.records[136]).toMatchObject({ seq: 137 });
  }, 30_000);
});

describe('TC-NFR-06-003：原子写中断，旧文件完好', () => {
  it('第 3 次写在 rename 前被 SIGKILL：目标文件仍是第 2 版完整内容', async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, 'state.json');

    const run = await runHarness(['json', file, '5'], {
      AIDLE_TEST_CRASH_AT: '3',
      AIDLE_TEST_CRASH_PHASE: 'before-rename',
    });

    expect(
      run.signal !== null || run.code !== 0,
      `子进程未被强制终止（code=${run.code} signal=${run.signal} stderr=${run.stderr}）`,
    ).toBe(true);
    expect(run.stderr).not.toContain('[harness] done');

    const raw = await readFile(file, 'utf8');
    expect(JSON.parse(raw)).toEqual({ version: 2, note: '第 2 版' });

    // 残留的临时文件不得污染目标文件；恢复时读到的一定是完整版本
    const entries = await readdir(dir);
    expect(entries).toContain('state.json');
    expect(await new JsonStore(file).read()).toEqual({ version: 2, note: '第 2 版' });
  }, 30_000);
});
