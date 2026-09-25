import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * TC-NFR-06-004（NFR-06 / 测试文档 §12.5）：WAP 时序经网关主链路验证。
 *
 * 注入点选在 persistAndDeliver 的「IC 消息 fsync 完成」处（AIDLE_TEST_CRASH_AT=7，
 * 写计数构成见 gateway-harness.mjs 头注）——进程死于落盘之后、msg:broadcast 之前：
 *   一半：崩溃前该消息从未广播（harness 若收到 ic-broadcast/post-ic 事件即失败）；
 *   另一半：重启后启动恢复出 lastSeq，Host 重连携带 lastSeq=0 → 精确补发该消息，
 *   证明「凡已广播者必已落盘」的反面——已落盘而未广播的消息不丢。
 */

const HARNESS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'gateway-harness.mjs');

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

interface HarnessEvent {
  event: string;
  [key: string]: unknown;
}

async function readEvents(dataDir: string): Promise<HarnessEvent[]> {
  const raw = await readFile(path.join(dataDir, 'harness-events.jsonl'), 'utf8');
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as HarnessEvent);
}

const findEvent = (events: HarnessEvent[], name: string): HarnessEvent | undefined =>
  events.find((e) => e.event === name);

afterAll(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('TC-NFR-06-004：WAP 时序（广播前 kill → 重启后该消息已持久化）', () => {
  it('IC 落盘后、广播前 SIGKILL：该消息未广播；重启后由启动恢复补发', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'bv-wap-'));
    created.push(dataDir);

    // ---- 阶段一：建房 → 进房 → 开团 → 发 IC，进程死于 IC 的 fsync 后 ----
    const crashed = await runHarness([dataDir, 'run'], { AIDLE_TEST_CRASH_AT: '7' });

    expect(
      crashed.signal !== null || crashed.code !== 0,
      `子进程未被强制终止（code=${crashed.code} signal=${crashed.signal} stderr=${crashed.stderr}）`,
    ).toBe(true);
    expect(crashed.stderr).not.toContain('[harness] done');

    const runEvents = await readEvents(dataDir);
    expect(findEvent(runEvents, 'room')).toBeDefined();
    expect(findEvent(runEvents, 'session-ack')).toMatchObject({ ok: true });
    expect(findEvent(runEvents, 'ic-sent')).toBeDefined();
    // WAP 两半之一：fsync 后死，广播绝不可能发生
    expect(findEvent(runEvents, 'ic-broadcast'), '崩溃前不得出现任何广播').toBeUndefined();
    expect(findEvent(runEvents, 'post-ic'), '崩溃必须发生在注入等待窗口内').toBeUndefined();

    const room = findEvent(runEvents, 'room') as {
      id: string;
      inviteCode: string;
      hostToken: string;
    };

    // ---- 阶段二：同一 dataDir 重启，启动恢复 lastSeq，重连补发 ----
    const verified = await runHarness([dataDir, 'verify', room.inviteCode, room.hostToken]);

    expect(verified.code, `verify 阶段应正常退出：${verified.stderr}`).toBe(0);
    expect(verified.stderr).toContain('[harness] done');

    const verifyEvents = await readEvents(dataDir);
    const replayed = findEvent(verifyEvents, 'replayed') as {
      messages: Array<{ seq: number; type: string; content: string }>;
    };
    const ic = replayed.messages.find((m) => m.type === 'ic');
    expect(ic, '重启后必须补发出崩溃前那条 IC').toBeDefined();
    // notice（seq 1，开团系统消息）已正常广播；IC 是本 session 第 2 条消息
    expect(ic).toMatchObject({ seq: 2, content: 'WAP 注入消息' });
  }, 30_000);
});
