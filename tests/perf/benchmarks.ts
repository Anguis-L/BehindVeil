import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { io, type Socket } from 'socket.io-client';
import { PROTOCOL_VERSION } from '@behindveil/shared';
import { scanWorldBook } from '../../packages/server/src/domain/worldbook/scan.js';
import { buildPrompt } from '../../packages/server/src/pipeline/index.js';
import { createHeuristicTokenizer } from '../../packages/server/src/pipeline/tokenizer.js';
import {
  createDataLayout,
  type DataLayout,
} from '../../packages/server/src/adapters/storage/layout.js';
import { JsonlStore } from '../../packages/server/src/adapters/storage/jsonl-store.js';
import { BackupSyncer } from '../../packages/server/src/adapters/backup/syncer.js';
import { createMockLlm } from '../../packages/server/src/adapters/llm/mock.js';
import { createRoom } from '../../packages/server/src/domain/session/rooms.js';
import {
  BENCH_MESSAGES,
  buildBenchInput,
  buildF01WorldBook,
  percentile,
} from '../bench/fixture-f01.js';

/**
 * 首 token 基准的服务端经 dist 产物装载（tests/soak 同款约定）：
 * - 测的正是生产构建产物，基线口径与线上一致；
 * - fastify 依赖在 packages/server 内，tests/ 侧直接 import 源码的 attachGateway
 *   会因 pnpm 严格隔离解析不到（tests/perf 独立 vitest root 尤甚）。
 */
interface BenchServer {
  listen(opts: { port: number; host: string }): Promise<unknown>;
  close(): Promise<unknown>;
  server: { address(): AddressInfo | string | null };
}

type CreateServerLike = (opts: {
  dataDir: string;
  logger: boolean;
  llm: unknown;
}) => Promise<BenchServer>;

const SERVER_DIST = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'packages',
  'server',
  'dist',
  'index.js',
);

export async function loadCreateServer(): Promise<CreateServerLike> {
  const mod = (await import(pathToFileURL(SERVER_DIST).href)) as {
    createServer: unknown;
  };
  return mod.createServer as CreateServerLike;
}

/**
 * NFR-10 五基准实现（T-M10-00）。纯 Node 无 vitest 依赖，供 perf.test.ts 编排。
 *
 * - 世界书扫描 / 管线整体：复用 F-01 夹具（tests/bench/fixture-f01.ts），预热后取分位数；
 * - 首 token：真实网关（attachGateway + MockLlm）+ socket.io-client 回环，
 *   玩家 IC → 服务端首个 narration:delta 的间隔（TC-NFR-05-004 口径：纯服务端开销）；
 * - soak 短版：复用 tests/soak/soak-harness.mjs 被测子进程（dist 产物），
 *   3 客户端限速发包，量消息总量与 RSS 增量（TC-NFR-05-003 短跑口径）。
 */

export interface CpuMetrics {
  /** 200 次扫描一批的总耗时，30 批取最小（ms） */
  scan_batch_ms: number;
  /** 100 次管线一批的总耗时，30 批取最小（ms） */
  pipeline_batch_ms: number;
}

export interface BackupFsyncMetrics {
  /** 开热备相对不开的 fsync p99 增量（3 次尝试取最小，ms） */
  backup_fsync_p99_delta_ms: number;
  base_p99_ms: number;
  with_backup_p99_ms: number;
}

export interface SoakMetrics {
  soak_msgs_total: number;
  soak_rss_growth_mb: number;
}

/**
 * 扫描 + 管线基准（纯函数，一次运行两指标共享预热）。
 *
 * 统计量 = 批量总耗时的 30 批最小值（G-M10 校准注记）：F-01 单次扫描/管线在亚毫秒
 * 量级，逐次分位数（p50/p95）同机波动可达 10–40%（GC/调度噪声 + JIT 分层），
 * 20% 相对容差与 10% 重复性都无从谈起；批量总耗时把噪声摊平，min-of-batches 是
 * 最小干扰估计，回归敏感且可重复。p95 绝对预算（扫描 <50ms / 管线 <100ms）仍由
 * tests/bench/nfr05-bench.test.ts 把守——两半合起来即设计 §5.1 的 max() 预算形。
 */
export function runCpuBenchmarks(): CpuMetrics {
  const book = buildF01WorldBook();
  const texts = BENCH_MESSAGES.map((m) => m.content);

  const batchTotal = (fn: () => void, count: number): number => {
    const t0 = performance.now();
    for (let i = 0; i < count; i += 1) fn();
    return performance.now() - t0;
  };

  for (let i = 0; i < 500; i += 1) scanWorldBook(texts, book); // 预热至 JIT 稳态
  const scanBatches: number[] = [];
  for (let b = 0; b < 30; b += 1) {
    scanBatches.push(batchTotal(() => scanWorldBook(texts, book), 200));
  }

  const tokenizer = createHeuristicTokenizer();
  const input = buildBenchInput(book);
  for (let i = 0; i < 100; i += 1) buildPrompt(input, tokenizer);
  const pipelineBatches: number[] = [];
  for (let b = 0; b < 30; b += 1) {
    pipelineBatches.push(batchTotal(() => buildPrompt(input, tokenizer), 100));
  }

  return {
    scan_batch_ms: Math.min(...scanBatches),
    pipeline_batch_ms: Math.min(...pipelineBatches),
  };
}

// ---- 首 token 基准 ----

const MODULE_ID = 'mod-perf';

async function placeModule(layout: DataLayout): Promise<void> {
  const dir = path.join(layout.modulesDir, MODULE_ID);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      id: MODULE_ID,
      name: MODULE_ID,
      version: '1.0.0',
      rulebook: 'coc7',
      apiVersion: '1',
      entry: { kpCard: 'kp-card.json', worldBook: 'worldbook.json', initState: 'init-state.json' },
    }),
  );
  await writeFile(
    path.join(dir, 'kp-card.json'),
    JSON.stringify({
      spec: 'chara_card_v3',
      data: {
        name: '守秘人',
        description: '只叙述，不宣告判定。',
        scenario: '',
        first_mes: '',
        mes_example: '',
        extensions: { aidle: { rulebook: 'coc7' } },
      },
    }),
  );
  await writeFile(path.join(dir, 'worldbook.json'), JSON.stringify({ entries: [] }));
  await writeFile(
    path.join(dir, 'init-state.json'),
    JSON.stringify({ scene: { name: '', time: '', publicDesc: '' } }),
  );
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
  socket: Socket,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; message?: string }> {
  return new Promise((resolve) => socket.emit('room:join', payload, resolve));
}

/** 首 token 基准：N 轮 IC，每轮量 IC 发出 → 首个 narration:delta 的间隔，返回 p50 ms */
export async function runFirstTokenBench(samples = 20): Promise<number> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'bv-perf-token-'));
  // 每轮一段 [delta, stop]：MockLlm 的 chat 会一路吞脚本直到 stop/结尾，
  // 不分段的话第 0 轮就耗尽全脚本，后续轮次拿不到任何 delta
  const mock = createMockLlm({
    script: Array.from({ length: samples + 5 }, () => [
      { delta: '雾气自桥面涌起，守桥人抬起头。' },
      { stop: true as const },
    ]).flat(),
  });
  const createServer = await loadCreateServer();
  const app = await createServer({ dataDir, logger: false, llm: mock });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('监听地址异常');
  const port = address.port;
  const layout = createDataLayout(dataDir);

  // socket 引用提出 try：finally 里先关连接再关 server——Node server.close()
  // 会等存量连接结束，websocket 不断开 app.close() 就永不返回
  let host: Socket | undefined;
  let players: Socket[] = [];

  try {
    const room = await createRoom(layout, { name: 'perf' });
    await placeModule(layout);
    host = await connect(port);
    // 三名玩家轮发：限速 10 条/30s/人，单发送者打不满 20 样本
    players = [await connect(port), await connect(port), await connect(port)];
    const hostJoin = await join(host, {
      inviteCode: room.inviteCode,
      hostToken: room.hostToken,
      name: 'KP',
    });
    if (!hostJoin.ok) throw new Error(`Host 进房失败：${hostJoin.message}`);
    const startAck = await new Promise<{ ok: boolean; message?: string }>((resolve) =>
      host.emit(
        'session:start',
        {
          moduleId: MODULE_ID,
          settings: {
            provider: 'openai-compat',
            model: 'mock-model',
            temperature: 0.7,
            maxHistoryMessages: 40,
            worldBookBudgetTokens: 2000,
            scanDepth: 4,
          },
        },
        resolve,
      ),
    );
    if (!startAck.ok) throw new Error(`开团失败：${startAck.message}`);
    for (const [i, player] of players.entries()) {
      const playerJoin = await join(player, { inviteCode: room.inviteCode, name: `阿珂${i}` });
      if (!playerJoin.ok) throw new Error(`玩家进房失败：${playerJoin.message}`);
    }

    const intervals: number[] = [];
    for (let i = 0; i < samples; i += 1) {
      const sender = players[i % players.length] as Socket;
      const firstDelta = new Promise<void>((resolve) => {
        host.once('narration:delta', () => resolve());
      });
      const done = new Promise<void>((resolve) => {
        host.once('narration:done', () => resolve());
      });
      const t0 = performance.now();
      // msg:send 无 ack 回调（网关契约）：以首个 narration:delta 到达为测量终点，
      // 30s 超时护栏防悬挂；等 narration:done 再发下一条——AI 队列串行，
      // 上回合未完会让下一样本把排队时间记进服务端开销，污染基线口径
      sender.emit('msg:send', { type: 'ic', content: `perf 第 ${i} 轮推进` });
      await Promise.race([
        firstDelta,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('首 token 超时：30s 内未收到 narration:delta')),
            30_000,
          ),
        ),
      ]);
      intervals.push(performance.now() - t0);
      await Promise.race([
        done,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('AI 回合未结束：30s 内未收到 narration:done')), 30_000),
        ),
      ]);
    }

    return percentile(intervals, 0.5);
  } finally {
    host?.close();
    for (const player of players) player.close();
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

// ---- 备份 fsync 影响基准（T-M10-02，设计 §5.1 热备账户）----

/**
 * 主链路 fsync p99 增量：不开热备 vs 开热备（50ms 周期、并发搬运增量）各测 80 次
 * JsonlStore.append（write+fsync，同主链路语义），取 p99 之差；3 次尝试取最小——
 * 环境噪声（其他进程/杀软扫描）会整体抬高两次测量，最小差值才是同步器自身的贡献。
 */
export async function runBackupFsyncBench(): Promise<BackupFsyncMetrics> {
  const root = await mkdtemp(path.join(tmpdir(), 'bv-perf-fsync-'));
  const dataDir = path.join(root, 'data');
  const layout = createDataLayout(dataDir);
  await mkdir(path.join(dataDir, 'rooms', 'r1', 'sessions', 's1'), { recursive: true });
  await writeFile(
    path.join(dataDir, 'rooms', 'r1', 'sessions', 's1', 'messages.jsonl'),
    '',
    'utf8',
  );
  const messagesFile = path.join(dataDir, 'rooms', 'r1', 'sessions', 's1', 'messages.jsonl');

  const measureP99 = async (store: JsonlStore, times: number): Promise<number> => {
    const samples: number[] = [];
    for (let i = 0; i < times; i += 1) {
      const t0 = performance.now();
      await store.append({ blob: 'x'.repeat(200) });
      samples.push(performance.now() - t0);
    }
    return percentile(samples, 0.99);
  };

  try {
    let best: BackupFsyncMetrics | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const base = new JsonlStore(messagesFile);
      const baseP99 = await measureP99(base, 80);
      await base.close();

      const syncer = new BackupSyncer({
        dataDir,
        backupDir: path.join(root, 'backup'),
        layout,
        intervalMs: 50,
      });
      syncer.start();
      const withBackupStore = new JsonlStore(messagesFile);
      const withP99 = await measureP99(withBackupStore, 80);
      await withBackupStore.close();
      await syncer.stop();

      const candidate: BackupFsyncMetrics = {
        backup_fsync_p99_delta_ms: Math.max(0, withP99 - baseP99),
        base_p99_ms: baseP99,
        with_backup_p99_ms: withP99,
      };
      if (best === null || candidate.backup_fsync_p99_delta_ms < best.backup_fsync_p99_delta_ms) {
        best = candidate;
      }
    }
    return best as BackupFsyncMetrics;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ---- soak 短版基准 ----

interface SoakEvent {
  event: string;
  port?: number;
  rss?: number;
}

async function readEvents(dataDir: string): Promise<SoakEvent[]> {
  let raw: string;
  try {
    raw = await readFile(path.join(dataDir, 'soak-events.jsonl'), 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SoakEvent);
}

/** soak 短版：3 端限速发包 durationMs，量消息总量与被测进程 RSS 增量 */
export async function runSoakBench(durationMs = 6000): Promise<SoakMetrics> {
  const harness = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'soak',
    'soak-harness.mjs',
  );
  const dataDir = await mkdtemp(path.join(tmpdir(), 'bv-perf-soak-'));
  const child = spawn(process.execPath, [harness, dataDir], { stdio: 'ignore' });
  const exitPromise = new Promise<void>((resolve) => child.on('close', resolve));

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

  try {
    const res = await fetch(`http://127.0.0.1:${port}/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'perf soak 房' }),
    });
    const room = (await res.json()) as { inviteCode: string; hostToken: string };

    const host = await connect(port);
    const p1 = await connect(port);
    const p2 = await connect(port);

    let msgsTotal = 0;
    host.on('msg:broadcast', () => {
      msgsTotal += 1;
    });

    const hostJoin = await join(host, {
      inviteCode: room.inviteCode,
      name: 'KP',
      hostToken: room.hostToken,
    });
    if (!hostJoin.ok) throw new Error('Host 进房失败');
    await placeModuleForSoak(dataDir);
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
    if (!startAck.ok) throw new Error(`开团失败：${startAck.message}`);
    for (const [socket, name] of [
      [p1, '阿珂'],
      [p2, '老王'],
    ] as const) {
      const ack = await join(socket, { inviteCode: room.inviteCode, name });
      if (!ack.ok) throw new Error(`${name} 进房失败`);
    }

    const interval = Math.min(3500, Math.max(500, Math.floor(durationMs / 6)));
    const timers = [
      [host, 'KP'],
      [p1, '阿珂'],
      [p2, '老王'],
    ].map(([socket, name]) =>
      setInterval(
        () =>
          (socket as Socket).emit('msg:send', { type: 'ic', content: `${name} 的 perf soak 消息` }),
        interval,
      ),
    );

    await new Promise((r) => setTimeout(r, durationMs));
    for (const timer of timers) clearInterval(timer);
    await new Promise((r) => setTimeout(r, 800)); // drain

    for (const socket of [host, p1, p2]) socket.close();
    child.kill();
    await exitPromise;

    const rssSamples = (await readEvents(dataDir))
      .filter((e) => e.event === 'rss' && typeof e.rss === 'number')
      .map((e) => e.rss as number);
    const quarter = Math.max(2, Math.floor(rssSamples.length / 4));
    const head = rssSamples.slice(0, quarter).reduce((a, b) => a + b, 0) / quarter;
    const tail = rssSamples.slice(-quarter).reduce((a, b) => a + b, 0) / quarter;

    return {
      soak_msgs_total: msgsTotal,
      soak_rss_growth_mb: Math.max(0, (tail - head) / 1024 / 1024),
    };
  } finally {
    child.kill();
    await rm(dataDir, { recursive: true, force: true });
  }
}

/** soak 房间用最小模组包（与 tests/soak placeModule 同构；目录/文件名不同便于排障） */
async function placeModuleForSoak(dataDir: string): Promise<void> {
  const dir = path.join(dataDir, 'modules', 'mod-soak');
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      id: 'mod-soak',
      name: 'mod-soak',
      version: '1.0.0',
      rulebook: 'coc7',
      apiVersion: '1',
      entry: { kpCard: 'kp-card.json', worldBook: 'worldbook.json', initState: 'init-state.json' },
    }),
  );
  await writeFile(
    path.join(dir, 'kp-card.json'),
    JSON.stringify({
      spec: 'chara_card_v3',
      data: {
        name: '守秘人',
        description: '只叙述，不宣告判定。',
        scenario: '',
        first_mes: '',
        mes_example: '',
        extensions: { aidle: { rulebook: 'coc7' } },
      },
    }),
  );
  await writeFile(path.join(dir, 'worldbook.json'), JSON.stringify({ entries: [] }));
  await writeFile(
    path.join(dir, 'init-state.json'),
    JSON.stringify({ scene: { name: '', time: '', publicDesc: '' } }),
  );
}
