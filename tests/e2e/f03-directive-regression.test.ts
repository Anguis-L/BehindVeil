import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { io, type Socket } from 'socket.io-client';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type Message } from '@behindveil/shared';

/**
 * 从 packages/server 的**构建产物**取模块：tests/ 不在 pnpm workspace 内，
 * 解析不到 server 自己的依赖（fastify / socket.io），与 tests/dice 同口径。
 * 因此本文件需在 `pnpm build` 之后运行（根 `pnpm test` 已包含该顺序）。
 */
const SERVER_DIST = fileURLToPath(new URL('../../packages/server/dist', import.meta.url));

const { attachGateway } = (await import(
  pathToFileURL(path.join(SERVER_DIST, 'gateway/socket.js')).href
)) as {
  attachGateway(app: unknown, deps: unknown): GatewayHandle;
};

const { createDataLayout } = (await import(
  pathToFileURL(path.join(SERVER_DIST, 'adapters/storage/layout.js')).href
)) as { createDataLayout(root: string): DataLayout };

const { saveStateBoard } = (await import(
  pathToFileURL(path.join(SERVER_DIST, 'domain/stateboard/board.js')).href
)) as {
  saveStateBoard(
    layout: DataLayout,
    roomId: string,
    sessionId: string,
    board: unknown,
  ): Promise<void>;
};

const { createMockLlm } = (await import(
  pathToFileURL(path.join(SERVER_DIST, 'adapters/llm/mock.js')).href
)) as { createMockLlm(options: { script?: MockScriptStep[] }): MockLlmAdapter };

const { createRoom } = (await import(
  pathToFileURL(path.join(SERVER_DIST, 'domain/session/rooms.js')).href
)) as { createRoom(layout: DataLayout, input: { name: string }): Promise<RoomRecord> };

interface GatewayHandle {
  close(): Promise<void>;
  directiveStats(): { attempts: number; successes: number; rate: number };
}

interface DataLayout {
  readonly root: string;
  readonly directiveLogFile: string;
}

interface RoomRecord {
  id: string;
  inviteCode: string;
  hostToken: string;
}

interface MockLlmAdapter {
  readonly calls: unknown[];
}

/** MockLlm 脚本步骤（与 adapters/llm/mock.ts 同构；此处本地声明以免依赖 dist 的类型产物） */
type MockScriptStep =
  { delta: string } | { directive: Record<string, unknown> } | { stop: true } | { error: string };

/**
 * T-M3-07：F-03 剧本 50 轮回归（FR-05 / R-01，测试文档 §12.4，TC-FR-05-011）。
 *
 * headless 全链路（真实 Fastify + Socket.IO 网关 + 文件存储 + MockLlm），无需浏览器：
 * 50 个 AI 回合依次跑完一个脚本化短团，指令块形态覆盖
 *   · 正常检定（单块 / 一轮连续多块）
 *   · 格式错误块（缺分隔符的畸形 JSON，容错层修不回来）
 *   · 循环上限触发（一轮内第 4 块被拦，不计入分母）
 * 门禁断言：全部指令块合计成功率 ≥95%（§12.4 分母 = 成功 + 解析失败 + 白名单拒绝，
 * 截断块不计）；失败块原始文本自动落到 data/logs/ai-directive.jsonl 供回归分析。
 *
 * 剧本刻意把两个畸形块拉开 ≥20 个块的间距：降级链滑动窗口是 20 次，
 * 同窗口出现 2 次失败会触发少样本降级、甚至停用协议（停用后指令块既不计成功也不计失败），
 * 那样统计就不再反映剧本本身，门禁也失去意义。
 */

const SETTINGS = {
  provider: 'openai-compat',
  model: 'mock',
  temperature: 0.7,
  maxHistoryMessages: 40,
  worldBookBudgetTokens: 2000,
  scanDepth: 4,
  contextWindowTokens: 32_768,
  outputReserveTokens: 2_048,
};

/** 爱丽丝（名册 stub）具备的三项技能，轮换使用以贴近真实检定分布 */
const SKILLS = ['侦查', '聆听', '图书馆使用'] as const;

/**
 * 畸形指令块：删掉字段分隔逗号。
 * 刻意不用尾逗号——repairJson 专门修尾逗号（T-M3-01），那种畸形到扫描层会被修好，
 * 注入等于没注入；缺分隔符是容错层修不回来的形态。
 */
const MALFORMED_BLOCK = [
  '```aidle',
  '{"op": "check",',
  '"target": "pc:alice"',
  '"skill": "侦查"}',
  '```',
  '',
].join('\n');

type RoundKind = 'single' | 'double' | 'malformed' | 'loopLimit';

interface Round {
  kind: RoundKind;
  /** 本轮计入 R-01 分母的指令块数（循环上限被拦的那一块不计） */
  blocks: number;
  /** 本轮预期失败块数（畸形块） */
  fails: number;
  /** 本回合落盘的 NarrationMsg 条数（= LLM 请求次数，每请求一段） */
  narrations: number;
  steps: MockScriptStep[];
}

function makeRound(kind: RoundKind, i: number): Round {
  const dir = (n: number): MockScriptStep => ({
    directive: {
      op: 'check',
      target: 'pc:alice',
      skill: SKILLS[(i + n) % SKILLS.length] ?? '侦查',
      difficulty: 'normal',
      label: `R${i}-${n}`,
    },
  });
  // 栅栏必须落在行首：MockLlm 的 directive 步骤不带前后换行，换行由相邻 delta 供给
  const nl: MockScriptStep = { delta: '\n' };

  switch (kind) {
    case 'single':
      return {
        kind,
        blocks: 1,
        fails: 0,
        narrations: 2,
        steps: [
          { delta: `【R${i}】走廊尽头透出微光。\n` },
          dir(1),
          { stop: true },
          { delta: '你握紧了手电。' },
          { stop: true },
        ],
      };
    case 'double':
      return {
        kind,
        blocks: 2,
        fails: 0,
        narrations: 3,
        steps: [
          { delta: `【R${i}】门缝下有光。\n` },
          dir(1),
          { stop: true },
          { delta: '你贴耳去听。\n' },
          dir(2),
          { stop: true },
          { delta: '里面有人在低声念诵。' },
          { stop: true },
        ],
      };
    case 'malformed':
      return {
        kind,
        blocks: 1,
        fails: 1,
        narrations: 1,
        steps: [
          { delta: `【R${i}】书页被撕去一半。\n` },
          { delta: MALFORMED_BLOCK },
          { stop: true },
        ],
      };
    case 'loopLimit':
      return {
        kind,
        blocks: 3,
        fails: 0,
        narrations: 2,
        steps: [
          { delta: `【R${i}】你连着翻找。\n` },
          dir(1),
          nl,
          dir(2),
          nl,
          dir(3),
          nl,
          dir(4),
          { stop: true },
          { delta: 'KP 强制收尾。' },
          { stop: true },
        ],
      };
  }
}

/** 50 轮剧本：两个畸形块相距 21 个块，任一 20 次滑动窗口内最多 1 次失败（不触发降级） */
function buildRounds(): Round[] {
  const kinds: RoundKind[] = [
    ...Array<RoundKind>(10).fill('single'),
    'malformed',
    ...Array<RoundKind>(20).fill('single'),
    'malformed',
    ...Array<RoundKind>(5).fill('double'),
    ...Array<RoundKind>(10).fill('single'),
    ...Array<RoundKind>(2).fill('loopLimit'),
    'single',
  ];
  return kinds.map((kind, i) => makeRound(kind, i));
}

interface Harness {
  layout: DataLayout;
  gateway: GatewayHandle;
  host: Socket;
  player: Socket;
  mock: MockLlmAdapter;
  hostFeed: Feed;
  playerFeed: Feed;
  cleanup(): Promise<void>;
}

interface Feed {
  msgs: Message[];
  errors: { code: string; message: string }[];
}

function collect(client: Socket): Feed {
  const feed: Feed = { msgs: [], errors: [] };
  client.on('msg:broadcast', (p: { msg: Message }) => feed.msgs.push(p.msg));
  client.on('error:app', (p: { code: string; message: string }) => feed.errors.push(p));
  return feed;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await sleep(15);
  }
}

async function startHarness(script: MockScriptStep[]): Promise<Harness> {
  // 不递归删除临时目录：沙箱的批量删除守卫会挂住钩子（与被测行为无关），
  // 目录落在系统临时区由 OS 回收。
  const dataDir = await mkdtemp(path.join(tmpdir(), 'bv-e2e-f03-'));
  const layout = createDataLayout(dataDir);
  // attachGateway 只消费 app.server（据此挂 Socket.IO）与 addHook('onClose')，
  // 无需整套 Fastify——tests/ 解析不到 server 自己的依赖。
  const server = createHttpServer();
  const onCloseHooks: (() => unknown)[] = [];
  const app = {
    server,
    addHook(name: string, fn: () => unknown): void {
      if (name === 'onClose') onCloseHooks.push(fn);
    },
  };
  const mock = createMockLlm({ script });
  const gateway = attachGateway(app, {
    layout,
    initialSeqs: new Map(),
    llm: mock,
    chat: { model: 'mock', temperature: 0.7, maxTokens: 2048 },
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;

  const connect = (): Promise<Socket> =>
    new Promise((resolve, reject) => {
      const client = io(`http://127.0.0.1:${port}`, {
        auth: { protocol: PROTOCOL_VERSION },
        transports: ['websocket'],
        reconnection: false,
        timeout: 5000,
      });
      client.on('connect', () => resolve(client));
      client.on('connect_error', (err: Error) => {
        client.close();
        reject(err);
      });
    });

  const room = await createRoom(layout, { name: 'F-03 回归房' });
  const host = await connect();
  const hostAck = await new Promise<{ ok: boolean }>((resolve) =>
    host.emit(
      'room:join',
      { inviteCode: room.inviteCode, hostToken: room.hostToken, name: 'KP' },
      resolve,
    ),
  );
  if (!hostAck.ok) throw new Error('Host 进房失败');
  const sessionAck = await new Promise<{ ok: boolean; session?: { id: string } }>((resolve) =>
    host.emit('session:start', { moduleId: 'f-03', settings: SETTINGS }, resolve),
  );
  if (!sessionAck.ok || !sessionAck.session) throw new Error('开团失败');
  // T-M5-04 真实名册：检定取值来自状态板（不再有 stub 的硬编码 alice）——
  // 装配一块含 alice 的初始板，供 50 轮剧本 pc:alice 检定取值。
  await saveStateBoard(layout, room.id, sessionAck.session.id, {
    version: 0,
    pcs: {
      alice: {
        sheet: {
          playerName: '爱丽丝',
          occupation: '记者',
          str: 50,
          con: 60,
          siz: 55,
          dex: 70,
          app: 50,
          int: 75,
          pow: 55,
          edu: 80,
          luck: 40,
          hp: 11,
          mp: 11,
          san: 55,
          db: '0',
          build: '0',
          skills: { 侦查: 60, 聆听: 45, 图书馆使用: 50 },
        },
        conditions: [],
      },
    },
    scene: { name: '', time: '', publicDesc: '' },
    facts: [],
    updatedAt: new Date().toISOString(),
  });
  const player = await connect();
  const playerAck = await new Promise<{ ok: boolean }>((resolve) =>
    player.emit(
      'room:join',
      { inviteCode: room.inviteCode, name: '阿探', wantRole: 'player' },
      resolve,
    ),
  );
  if (!playerAck.ok) throw new Error('玩家进房失败');

  return {
    layout,
    gateway,
    host,
    player,
    mock,
    hostFeed: collect(host),
    playerFeed: collect(player),
    cleanup: async () => {
      host.close();
      player.close();
      await gateway.close();
      for (const hook of onCloseHooks) await hook();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

describe('F-03：50 轮指令解析回归（TC-FR-05-011）', () => {
  it('50 轮剧本跑完：成功率 ≥95%，失败块留档，全链路无错误', async () => {
    const rounds = buildRounds();
    const script = rounds.flatMap((r) => r.steps);
    const srv = await startHarness(script);

    try {
      const stats = (): { attempts: number; successes: number; rate: number } =>
        srv.gateway.directiveStats();
      const narrationCount = (): number =>
        srv.hostFeed.msgs.filter((m) => m.type === 'narration').length;

      let expectedBlocks = 0;
      let expectedNarrations = 0;

      for (let i = 0; i < rounds.length; i += 1) {
        const round = rounds[i];
        if (!round) continue;
        expectedBlocks += round.blocks;
        expectedNarrations += round.narrations;
        // ai:invoke 触发（D-07）：每完成一个 AI 回合开新「轮」，故逐轮串行调用
        srv.player.emit('ai:invoke', { reason: `R${i}` });
        await waitFor(
          () => stats().attempts >= expectedBlocks && narrationCount() >= expectedNarrations,
          15_000,
          `第 ${i} 轮（${round.kind}）完成`,
        );
        // finishNarration 广播后 aiRounds 才自增；留一跳避免下一轮撞上「每人每轮 1 次」限流
        await sleep(40);
      }

      const total = stats();
      // 剧本口径：59 个计分母的指令块，其中 2 个畸形块失败 → 57/59 ≈ 96.6%
      expect(total.attempts).toBe(59);
      expect(total.successes).toBe(57);
      expect(total.rate).toBeGreaterThanOrEqual(0.95);

      // 失败块留档（测试文档 §12.4）：两条，带原始文本与原因
      const log = await readFile(srv.layout.directiveLogFile, 'utf8');
      const lines = log.trim().split('\n');
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        const entry = JSON.parse(line) as {
          kind: string;
          reason: string;
          raw: string;
          sessionId: string;
        };
        expect(entry.kind).toBe('parse-error');
        expect(entry.raw).toContain('"target": "pc:alice"');
        expect(entry.reason).not.toBe('');
        expect(entry.sessionId).not.toBe('');
      }

      // 全程无业务错误：E-AI-01 只达 Host（畸形块），玩家侧零告警；
      // 也不该有 E-ROOM-01（若 ai:invoke 撞限流会出现，说明轮次驱动有问题）
      expect(srv.hostFeed.errors.filter((e) => e.code !== 'E-AI-01')).toEqual([]);
      expect(srv.playerFeed.errors).toEqual([]);
      expect(srv.hostFeed.errors.filter((e) => e.code === 'E-AI-01').length).toBeGreaterThanOrEqual(
        2,
      );

      // 降级链未被触发（剧本刻意拉开畸形块间距）：窗口成功率始终 ≥95%
      expect(srv.mock.calls.length).toBeGreaterThanOrEqual(50);
    } finally {
      await srv.cleanup();
    }
  }, 120_000);
});
