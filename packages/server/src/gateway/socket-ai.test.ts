import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { io, type Socket } from 'socket.io-client';
import { afterAll, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type Message } from '@behindveil/shared';
import { createDataLayout, type DataLayout } from '../adapters/storage/layout.js';
import { createMockLlm, type MockLlmAdapter, type MockScriptStep } from '../adapters/llm/mock.js';
import type { LlmAdapter } from '../domain/llm.js';
import { createRoom } from '../domain/session/rooms.js';
import { saveStateBoard } from '../domain/stateboard/board.js';
import type { StateBoard } from '@behindveil/shared';
import { attachGateway } from './socket.js';

/**
 * T-M3-06：AI 触发与检定闭环的网关集成测试（TDD §4.1/§5.4，D-07）。
 *
 * 真实 socket.io-client + MockLlm 脚本，覆盖：
 * - IC 自动触发全链路（TC-FR-05-006）：narration:delta → DiceMsg → 回注 → 续写 → narration:done
 * - 防篡改端到端（TC-FR-05-008）：指令夹带数值字段 → 白名单拒绝，E-AI-01 只达 Host，玩家无感
 * - 循环上限（TC-FR-05-007）：第 4 块被拦，只有 3 次 DiceMsg
 * - ai:invoke 每人每轮 1 次（TC-FR-05-010，D-07 轮定义）
 * - AI 忙时排队串行（TC-FR-03-005）：两条 IC 各恰好触发一次响应，不丢不交错
 *
 * 口径注记：MockLlm 的 directive 步骤本身不带前后换行——栅栏行首/行尾换行
 * 由相邻 delta 供给（真实 LLM 输出亦如此；扫描器按行识别栅栏）。
 */

const settings = {
  provider: 'openai-compat',
  model: 'deepseek-chat',
  temperature: 0.7,
  maxHistoryMessages: 40,
  worldBookBudgetTokens: 2000,
  scanDepth: 4,
};

const created: string[] = [];

interface AiServer {
  port: number;
  inviteCode: string;
  layout: DataLayout;
  host: Socket;
  player: Socket;
  mock: MockLlmAdapter;
  cleanup(): Promise<void>;
}

async function startAiServer(
  script: MockScriptStep[],
  opts: { llm?: LlmAdapter } = {},
): Promise<AiServer> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'bv-socket-ai-'));
  created.push(dataDir);
  const layout = createDataLayout(dataDir);
  const app: FastifyInstance = Fastify({ logger: false });
  const mock = createMockLlm({ script });
  const gateway = attachGateway(app, {
    layout,
    initialSeqs: new Map(),
    llm: opts.llm ?? mock,
    chat: { model: 'mock-model', temperature: 0.7, maxTokens: 2048 },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;

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

  const room = await createRoom(layout, { name: 'AI 房' });
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
    host.emit('session:start', { moduleId: 'mod-1', settings }, resolve),
  );
  if (!sessionAck.ok || !sessionAck.session) throw new Error('开团失败');
  // T-M5-04 真实名册：检定取值来自状态板（不再有 stub 的硬编码 alice）——
  // 装配一块含 alice 的初始板，供 Mock 剧本 pc:alice 检定取值。
  const aliceBoard: StateBoard = {
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
          skills: { 侦查: 60, 图书馆使用: 50, 聆听: 45, 急救: 50, 攀爬: 65 },
        },
        conditions: [],
      },
    },
    scene: { name: '', time: '', publicDesc: '' },
    facts: [],
    updatedAt: new Date().toISOString(),
  };
  await saveStateBoard(layout, room.id, sessionAck.session.id, aliceBoard);
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
    port,
    inviteCode: room.inviteCode,
    layout,
    host,
    player,
    mock,
    cleanup: async () => {
      host.close();
      player.close();
      await gateway.close();
      await app.close();
    },
  };
}

afterAll(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Feed {
  msgs: Message[];
  deltas: string[];
  dones: number[];
  errors: { code: string; message: string }[];
}

function collect(client: Socket): Feed {
  const feed: Feed = { msgs: [], deltas: [], dones: [], errors: [] };
  client.on('msg:broadcast', (p: { msg: Message }) => feed.msgs.push(p.msg));
  client.on('narration:delta', (p: { delta: string }) => feed.deltas.push(p.delta));
  client.on('narration:done', (p: { seq: number }) => feed.dones.push(p.seq));
  client.on('error:app', (p: { code: string; message: string }) => feed.errors.push(p));
  return feed;
}

async function waitFor(cond: () => boolean, ms = 4000, label = '条件'): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const check = {
  op: 'check',
  target: 'pc:alice',
  skill: '侦查',
  difficulty: 'normal',
  label: '翻查书桌',
};

describe('IC 自动触发全链路（TC-FR-05-006 / TC-FR-03-004）', () => {
  it('narration:delta → DiceMsg → 回注 → 续写 → done，玩家与 Host 同见且无错误', async () => {
    const srv = await startAiServer([
      { delta: '你翻查书桌。\n' },
      { directive: check },
      { delta: '\n抽屉里有一把铜钥匙。' },
      { stop: true },
      { delta: '你继续搜查书房。' },
    ]);
    const hostFeed = collect(srv.host);
    const playerFeed = collect(srv.player);

    srv.player.emit('msg:send', { type: 'ic', content: '我翻查书桌。' });
    await waitFor(() => hostFeed.dones.length >= 2, 4000, '两次 narration:done（本段 + 续写）');

    // 掷骰恰好一次，数值服务端拼出：1d100<=60（爱丽丝 侦查），判定记录在案
    const dice = hostFeed.msgs.filter((m) => m.type === 'dice');
    expect(dice).toHaveLength(1);
    const roll = (
      dice[0] as { roll: { expr: string; total: number; check?: { kind: string; target: number } } }
    ).roll;
    expect(roll.expr).toBe('1d100<=60');
    expect(roll.check).toMatchObject({ kind: 'skill', target: 60 });

    // 回注 SystemMsg{ai_directive_result} 在 DiceMsg 之后落盘（seq 顺序）
    const system = hostFeed.msgs.filter(
      (m) => m.type === 'system' && m.subtype === 'ai_directive_result',
    );
    expect(system).toHaveLength(1);
    expect((system[0] as { content: string }).content).toContain('【检定】爱丽丝 侦查（翻查书桌）');
    expect((system[0] as { seq: number }).seq).toBeGreaterThan((dice[0] as { seq: number }).seq);

    // 两段叙事分别落盘；全部 delta 拼装 = 两段 NarrationMsg 内容之和（TC-FR-03-004）
    const narrations = hostFeed.msgs.filter((m) => m.type === 'narration');
    expect(narrations).toHaveLength(2);
    const joined = hostFeed.deltas.join('');
    const contents = narrations.map((m) => (m as { content: string }).content).join('');
    expect(joined).toBe(contents);
    expect(contents).toContain('你翻查书桌。');
    expect(contents).toContain('你继续搜查书房。');

    // 玩家与 Host 同见掷骰/回注/叙事；双方均无 error:app（E-AI-01 玩家无感、KP 无错）
    expect(playerFeed.msgs.map((m) => m.seq)).toEqual(hostFeed.msgs.map((m) => m.seq));
    expect(playerFeed.dones).toEqual(hostFeed.dones);
    expect(hostFeed.errors).toHaveLength(0);
    expect(playerFeed.errors).toHaveLength(0);

    await srv.cleanup();
  });
});

describe('防篡改端到端（TC-FR-05-008）', () => {
  it('指令夹带 skillValue 数值字段 → 白名单拒绝：不掷骰，E-AI-01 只达 Host', async () => {
    const srv = await startAiServer([
      { delta: '你试图直接宣告结果。\n' },
      { directive: { ...check, skillValue: 99 } },
      { delta: '\n但规则不承认。' },
    ]);
    const hostFeed = collect(srv.host);
    const playerFeed = collect(srv.player);

    srv.player.emit('msg:send', { type: 'ic', content: '我宣称侦查成功。' });
    await waitFor(() => hostFeed.dones.length >= 1, 4000, '本段 narration:done');

    expect(hostFeed.msgs.some((m) => m.type === 'dice')).toBe(false);
    expect(
      hostFeed.msgs.some((m) => m.type === 'system' && m.subtype === 'ai_directive_result'),
    ).toBe(false);
    expect(hostFeed.errors.some((e) => e.code === 'E-AI-01')).toBe(true);
    // 玩家无感：无 error:app、无系统告警类消息
    expect(playerFeed.errors).toHaveLength(0);
    await srv.cleanup();
  });
});

describe('循环上限端到端（TC-FR-05-007）', () => {
  it('单次响应内 4 个指令块：前 3 块掷骰，第 4 块被拦并强制收尾', async () => {
    const srv = await startAiServer([
      { delta: '连续排查。\n' },
      { directive: { ...check, skill: '侦查' } },
      { delta: '\n' },
      { directive: { ...check, skill: '聆听' } },
      { delta: '\n' },
      { directive: { ...check, skill: '图书馆使用' } },
      { delta: '\n' },
      { directive: { ...check, skill: '撬锁' } },
      { delta: '\n收工。' },
      { stop: true },
    ]);
    const hostFeed = collect(srv.host);

    srv.player.emit('msg:send', { type: 'ic', content: '我把房间翻个底朝天。' });
    await waitFor(() => hostFeed.dones.length >= 2, 4000, '强制收尾的 narration:done');

    const dice = hostFeed.msgs.filter((m) => m.type === 'dice');
    expect(dice).toHaveLength(3); // 第 4 块被拦
    expect(hostFeed.errors.some((e) => e.code === 'E-AI-01' && e.message.includes('上限'))).toBe(
      true,
    );
    const contents = hostFeed.msgs
      .filter((m) => m.type === 'narration')
      .map((m) => (m as { content: string }).content)
      .join('');
    expect(contents).toContain('收工。'); // 收尾段存在
    await srv.cleanup();
  });
});

describe('ai:invoke 显式触发与限流（TC-FR-05-010，D-07）', () => {
  it('同一轮内第 2 次被限流；回合完成开启新一轮后可再次请求', async () => {
    // 可门控 LLM：回合卡在生成中，保证两次 invoke 落在同一「轮」内
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const gated: LlmAdapter = {
      id: 'gated',
      async chat(_req, onDelta) {
        await gate;
        onDelta('回合回应。');
        return { content: '回合回应。', finishReason: 'stop', aborted: false };
      },
    };
    const srv = await startAiServer([], { llm: gated });
    const playerFeed = collect(srv.player);

    srv.player.emit('ai:invoke', {});
    await new Promise((r) => setTimeout(r, 80)); // 回合已启动、卡在生成中
    srv.player.emit('ai:invoke', {}); // 同轮第 2 次 → 限流
    await waitFor(() => playerFeed.errors.length >= 1, 2000, '限流 error:app');
    expect(playerFeed.errors[0]).toMatchObject({ code: 'E-ROOM-01' });

    release(); // 回合完成 → 开启新一轮
    await waitFor(() => playerFeed.dones.length >= 1, 2000, '第一轮 done');
    await new Promise((r) => setTimeout(r, 60)); // 等 finally 轮计数自增

    srv.player.emit('ai:invoke', {}); // 新一轮 → 放行
    await waitFor(() => playerFeed.dones.length >= 2, 2000, '第二轮 done');
    expect(playerFeed.errors).toHaveLength(1); // 没有新增错误
    await srv.cleanup();
  });

  it('观察者请求 KP 响应被拒（player+ 权限）', async () => {
    const srv = await startAiServer([]);
    const observer = await new Promise<Socket>((resolve, reject) => {
      const client = io(`http://127.0.0.1:${srv.port}`, {
        auth: { protocol: PROTOCOL_VERSION },
        transports: ['websocket'],
        reconnection: false,
        timeout: 5000,
      });
      client.on('connect', () => resolve(client));
      client.on('connect_error', reject);
    });
    const feed = collect(observer);
    const ack = await new Promise<{ ok: boolean }>((resolve) =>
      observer.emit(
        'room:join',
        { inviteCode: srv.inviteCode, name: '旁听', wantRole: 'observer' },
        resolve,
      ),
    );
    expect(ack.ok).toBe(true);
    observer.emit('ai:invoke', {});
    await waitFor(() => feed.errors.length >= 1, 2000, '观察者 error:app');
    expect(feed.errors[0]).toMatchObject({ code: 'E-ROOM-01', message: '观察者不能请求 KP 响应' });
    observer.close();
    await srv.cleanup();
  });
});

describe('AI 忙时排队串行（TC-FR-03-005）', () => {
  it('两条 IC 陆续到达：各恰好触发一次响应，不丢不交错', async () => {
    const srv = await startAiServer([
      { delta: '回应一。\n' },
      { stop: true },
      { delta: '回应二。\n' },
    ]);
    const hostFeed = collect(srv.host);

    srv.player.emit('msg:send', { type: 'ic', content: '第一句话。' });
    srv.player.emit('msg:send', { type: 'ic', content: '第二句话。' });
    await waitFor(() => hostFeed.dones.length >= 2, 4000, '两次响应的 done');
    await new Promise((r) => setTimeout(r, 60)); // 确认没有第三段

    const narrations = hostFeed.msgs.filter((m) => m.type === 'narration');
    expect(narrations).toHaveLength(2);
    expect(narrations.map((m) => (m as { content: string }).content)).toEqual([
      '回应一。\n',
      '回应二。\n',
    ]);
    expect(hostFeed.errors).toHaveLength(0);
    await srv.cleanup();
  });
});
