import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import { PROTOCOL_VERSION, type Message } from '@behindveil/shared';

/**
 * TC-NFR-05-003（NFR-05 / 测试文档 §12.3）：3 端 soak。
 *
 * 口径：3 个 socket.io 客户端（1 Host + 2 玩家）全程在线，每人限速内发包
 * （≤10 条/30s）→ 断言全程 0 error:app、每 session seq 连续无空洞、
 * 被测进程 RSS 增长 <100MB。
 *
 * 时长由 AIDLE_SOAK_MS 控制：CI 默认 6 秒短跑（同一套断言，验证 soak 框架与
 * 质量口径）；门禁跑法 = `AIDLE_SOAK_MS=1800000 npx vitest run tests/soak`
 * （30 分钟满口径，it 超时随时长自动放大）。被测 server 在独立子进程
 * （tests/soak/soak-harness.mjs），RSS 从其自采样事件读取，不受本进程干扰。
 */

const SOAK_MS = Math.max(2000, Number(process.env.AIDLE_SOAK_MS ?? 6000));
const RSS_BUDGET = 100 * 1024 * 1024;
const HARNESS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'soak-harness.mjs');

const created: string[] = [];

interface SoakEvent {
  event: string;
  port?: number;
  rss?: number;
  ts?: number;
}

async function readEvents(dataDir: string): Promise<SoakEvent[]> {
  let raw: string;
  try {
    raw = await readFile(path.join(dataDir, 'soak-events.jsonl'), 'utf8');
  } catch {
    return []; // harness 尚未写出首行（轮询期文件可能还不存在）
  }
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SoakEvent);
}

afterAll(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** 收到的 seq 去重排序后相邻差恒为 1（无空洞） */
function expectNoGaps(client: string, seqs: number[]): number[] {
  const sorted = [...new Set(seqs)].sort((a, b) => a - b);
  expect(sorted.length, `${client} 至少应收到 1 条消息`).toBeGreaterThan(0);
  for (let i = 1; i < sorted.length; i++) {
    expect(sorted[i], `${client} 的 seq 在 ${sorted[i - 1]} 后出现空洞`).toBe(
      (sorted[i - 1] as number) + 1,
    );
  }
  return sorted;
}

function connect(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(`http://127.0.0.1:${port}`, {
      auth: { protocol: PROTOCOL_VERSION },
      transports: ['websocket'],
      reconnection: false,
      timeout: 5000,
    });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (err: Error) => {
      socket.close();
      reject(err);
    });
  });
}

function join(
  client: Socket,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; message?: string }> {
  return new Promise((resolve) => client.emit('room:join', payload, resolve));
}

describe(`TC-NFR-05-003：3 端 soak（${SOAK_MS / 1000}s，AIDLE_SOAK_MS 可拉满 30 分钟）`, () => {
  it(
    `3 客户端压测 ${SOAK_MS / 1000}s：0 error:app、seq 连续、RSS 增长 <100MB`,
    async () => {
      const dataDir = await mkdtemp(path.join(tmpdir(), 'bv-soak-'));
      created.push(dataDir);

      const child = spawn(process.execPath, [HARNESS, dataDir], { stdio: 'ignore' });
      const exitPromise = new Promise<void>((resolve) => child.on('close', resolve));

      // 等被测 server 就绪（轮询自采样事件文件）
      let port = 0;
      const deadline = Date.now() + 30_000;
      for (;;) {
        const listening = (await readEvents(dataDir)).find((e) => e.event === 'listening');
        if (listening?.port) {
          port = listening.port;
          break;
        }
        if (Date.now() > deadline) throw new Error('soak-harness 30s 内未就绪');
        await new Promise((r) => setTimeout(r, 100));
      }

      // REST 建房 → 1 Host + 2 玩家进房 → Host 开团
      const res = await fetch(`http://127.0.0.1:${port}/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'soak 房' }),
      });
      const room = (await res.json()) as { inviteCode: string; hostToken: string };

      const host = await connect(port);
      const p1 = await connect(port);
      const p2 = await connect(port);

      // 监听必须先于一切动作：notice/join 系统消息也会广播（seq 从 1 起）
      const errors: Array<{ code: string; message: string }> = [];
      const seqs: Record<string, number[]> = { host: [], p1: [], p2: [] };
      const onBroadcast = (key: string) => (payload: { msg: Message }) => {
        seqs[key]?.push(payload.msg.seq);
      };
      for (const socket of [host, p1, p2]) {
        socket.on('error:app', (payload: { code: string; message: string }) =>
          errors.push(payload),
        );
      }
      host.on('msg:broadcast', onBroadcast('host'));
      p1.on('msg:broadcast', onBroadcast('p1'));
      p2.on('msg:broadcast', onBroadcast('p2'));

      const hostJoin = await join(host, {
        inviteCode: room.inviteCode,
        name: 'KP',
        hostToken: room.hostToken,
      });
      expect(hostJoin.ok, hostJoin.message).toBe(true);
      const startAck = await new Promise<{ ok: boolean; message?: string }>((resolve) =>
        host.emit(
          'session:start',
          {
            moduleId: 'mod-soak',
            settings: {
              provider: 'openai-compat',
              model: 'mock',
              temperature: 0.7,
              maxHistoryMessages: 40,
              worldBookBudgetTokens: 2000,
              scanDepth: 4,
            },
          },
          resolve,
        ),
      );
      expect(startAck.ok, startAck.message).toBe(true);

      for (const [socket, name] of [
        [p1, '阿珂'],
        [p2, '老王'],
      ] as const) {
        const ack = await join(socket, { inviteCode: room.inviteCode, name });
        expect(ack.ok, ack.message).toBe(true);
      }

      // 三端各自限速内发包：间隔 clamp(SOAK_MS/6, 500, 3500)ms。
      // 上限 3500ms 而非 3000：10 条/30s 顶格节奏会在滑动窗口边界（now-ts<30000）
      // 被毫秒级调度抖动翻成 11 条 → 触发限速（30 分钟满口径实测踩坑），留 15% 裕度。
      const interval = Math.min(3500, Math.max(500, Math.floor(SOAK_MS / 6)));
      const senders: Array<[Socket, string]> = [
        [host, 'KP'],
        [p1, '阿珂'],
        [p2, '老王'],
      ];
      const timers = senders.map(([socket, name]) =>
        setInterval(
          () => socket.emit('msg:send', { type: 'ic', content: `${name} 的 soak 消息` }),
          interval,
        ),
      );

      await new Promise((r) => setTimeout(r, SOAK_MS));
      for (const timer of timers) clearInterval(timer);
      await new Promise((r) => setTimeout(r, 800)); // drain：等尾部消息广播到位

      // ---- 断言 1：全程 0 error:app ----
      expect(errors, `不应出现任何 error:app：${JSON.stringify(errors)}`).toEqual([]);

      // ---- 断言 2：seq 连续无空洞 ----
      // host 全程在线（含 join 前的 notice），必须从 1 连到 N；
      // p1/p2 进房晚于 notice 广播（协议如此），断言收到片段无空洞且最终追平 host
      const hostSeqs = expectNoGaps('host', seqs['host'] as number[]);
      expect(hostSeqs[0], 'host 应从 seq 1 收齐').toBe(1);
      for (const client of ['p1', 'p2'] as const) {
        const tail = expectNoGaps(client, seqs[client] as number[]);
        expect(tail.at(-1), `${client} 应追平 host 的最大 seq`).toBe(hostSeqs.at(-1));
      }

      // ---- 断言 3：被测进程 RSS 增长 <100MB（前 25% 采样均值 vs 后 25% 均值）----
      child.kill();
      await exitPromise;
      const rssSamples = (await readEvents(dataDir))
        .filter((e) => e.event === 'rss' && typeof e.rss === 'number')
        .map((e) => e.rss as number);
      expect(rssSamples.length, 'RSS 采样不足').toBeGreaterThanOrEqual(4);
      const quarter = Math.max(2, Math.floor(rssSamples.length / 4));
      const head = rssSamples.slice(0, quarter).reduce((a, b) => a + b, 0) / quarter;
      const tail = rssSamples.slice(-quarter).reduce((a, b) => a + b, 0) / quarter;
      const growth = tail - head;
      expect(
        growth,
        `被测进程 RSS 增长 ${(growth / 1024 / 1024).toFixed(1)}MB 超出预算 100MB`,
      ).toBeLessThan(RSS_BUDGET);

      for (const socket of [host, p1, p2]) socket.close();
    },
    SOAK_MS + 120_000,
  );
});
