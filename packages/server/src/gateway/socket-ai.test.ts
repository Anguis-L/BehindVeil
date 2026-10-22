import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import { createRoom, findByInviteCode } from '../domain/session/rooms.js';
import { readStateBoard, saveStateBoard } from '../domain/stateboard/board.js';
import { replayAuditFile } from '../tools/audit-replay.js';
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
  playerMemberId: string;
  mock: MockLlmAdapter;
  cleanup(): Promise<void>;
}

async function startAiServer(
  script: MockScriptStep[],
  opts: { llm?: LlmAdapter; rulebook?: 'coc7' | 'dnd5e' } = {},
): Promise<AiServer> {
  const rulebook = opts.rulebook ?? 'coc7';
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
  // T-M5-05：开团前置是模组包存在——放置最小合法包（manifest + 三件套）
  const modDir = path.join(layout.modulesDir, 'mod-1');
  await mkdir(modDir, { recursive: true });
  await writeFile(
    path.join(modDir, 'manifest.json'),
    JSON.stringify({
      id: 'mod-1',
      name: 'mod-1',
      version: '1.0.0',
      rulebook,
      apiVersion: '1',
      entry: { kpCard: 'kp-card.json', worldBook: 'worldbook.json', initState: 'init-state.json' },
    }),
  );
  await writeFile(
    path.join(modDir, 'kp-card.json'),
    JSON.stringify({
      spec: 'chara_card_v3',
      data: {
        name: '守秘人',
        description: '只叙述，不宣告判定。',
        scenario: '',
        first_mes: '',
        mes_example: '',
        extensions: { aidle: { rulebook } },
      },
    }),
  );
  await writeFile(path.join(modDir, 'worldbook.json'), JSON.stringify({ entries: [] }));
  await writeFile(
    path.join(modDir, 'init-state.json'),
    JSON.stringify({ scene: { name: '', time: '', publicDesc: '' } }),
  );
  const sessionAck = await new Promise<{ ok: boolean; session?: { id: string } }>((resolve) =>
    host.emit('session:start', { moduleId: 'mod-1', settings }, resolve),
  );
  if (!sessionAck.ok || !sessionAck.session) throw new Error('开团失败');
  // T-M5-04 真实名册：检定取值来自状态板（不再有 stub 的硬编码 alice）——
  // 装配一块含 alice 的初始板，供 Mock 剧本 pc:alice 检定取值；5e 房给 5e 卡（T-M8-03 E2E）。
  const aliceBoard: StateBoard = {
    version: 0,
    pcs: {
      alice: {
        sheet:
          rulebook === 'dnd5e'
            ? {
                rulebook: 'dnd5e',
                playerName: '爱丽丝',
                occupation: '战士',
                abilities: { str: 16, dex: 14, con: 14, int: 10, wis: 12, cha: 8 },
                proficiencyBonus: 2,
                ac: 16,
                hp: { max: 22, current: 22 },
                proficientSkills: [],
                proficientSaves: ['str', 'con'],
              }
            : {
                rulebook: 'coc7',
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
        resources: [],
      },
    },
    scene: { name: '', time: '', publicDesc: '' },
    facts: [],
    updatedAt: new Date().toISOString(),
  };
  await saveStateBoard(layout, room.id, sessionAck.session.id, aliceBoard);
  const player = await connect();
  const playerAck = await new Promise<{ ok: boolean; memberId?: string }>((resolve) =>
    player.emit(
      'room:join',
      { inviteCode: room.inviteCode, name: '阿探', wantRole: 'player' },
      resolve,
    ),
  );
  if (!playerAck.ok || !playerAck.memberId) throw new Error('玩家进房失败');

  return {
    port,
    inviteCode: room.inviteCode,
    layout,
    host,
    player,
    playerMemberId: playerAck.memberId,
    mock,
    cleanup: async () => {
      host.close();
      player.close();
      await gateway.close();
      await app.close();
    },
  };
}

/** 清理带超时竞速（沙箱 rm 慢，单次数百毫秒会撞 hook 超时；见 worldbook/store.test.ts 同款说明） */
async function rmQuietly(dir: string): Promise<void> {
  await Promise.race([
    rm(dir, { recursive: true, force: true }).catch(() => undefined),
    new Promise((r) => setTimeout(r, 2_000)),
  ]);
}

afterAll(async () => {
  await Promise.all(created.splice(0).map((dir) => rmQuietly(dir)));
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
      // 第 4 块被拦后本轮请求即结束；强制收尾是**下一次**请求，剧本要给它真内容
      // （否则收尾回包为空，会被 2026-10-08 的空回包不落盘规则吞掉 done）。
      { stop: true },
      { delta: '收工。' },
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

describe('剧本耗尽：空内容不落盘（2026-10-08 模拟实团回归）', () => {
  it('MockLlm 空脚本：空叙事既不落盘也不广播 done，界面不留空气泡', async () => {
    const srv = await startAiServer([]); // 空剧本 = KP 无话可说
    const hostFeed = collect(srv.host);

    srv.player.emit('msg:send', { type: 'ic', content: '我屏住呼吸，等着。' });
    // 剧本耗尽仍会走完一次 AI 回合（finishNarration 被调用），但内容为空 → 应被丢弃。
    // 等玩家那条 ic 落盘即说明该回合已处理完（回合串行，ic 先于叙事落盘）。
    await waitFor(() => hostFeed.msgs.some((m) => m.type === 'ic'), 4000, '玩家 ic 落盘');
    await new Promise((r) => setTimeout(r, 200));

    const narrations = hostFeed.msgs.filter((m) => m.type === 'narration');
    expect(narrations).toHaveLength(0); // 空叙事不落盘
    expect(hostFeed.dones).toHaveLength(0); // 也不广播 done（否则前端挂空占位）
    expect(hostFeed.msgs.some((m) => m.type === 'ic')).toBe(true); // 玩家发言照常落盘
    await srv.cleanup();
  });

  it('非空内容照常落盘（防空判回归）', async () => {
    const srv = await startAiServer([{ delta: '潮声在雾里滚了一圈。' }, { stop: true }]);
    const hostFeed = collect(srv.host);

    srv.player.emit('msg:send', { type: 'ic', content: '我侧耳听。' });
    await waitFor(() => hostFeed.dones.length >= 1, 4000, '非空叙事的 done');

    expect(hostFeed.msgs.filter((m) => m.type === 'narration')).toHaveLength(1);
    await srv.cleanup();
  });

  it('ai:invoke 显式触发：剧本耗尽空回包仍广播 done（调用方按 done 等回包）', async () => {
    // 守卫过宽会让这里永久挂住：KP 主动要回应，等的是信号而不是正文。
    const srv = await startAiServer([]); // 空剧本
    const hostFeed = collect(srv.host);

    srv.host.emit('ai:invoke', {});
    await waitFor(() => hostFeed.dones.length >= 1, 4000, 'ai:invoke 的 done');

    expect(hostFeed.dones).toHaveLength(1);
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

  it('玩家断开后配额记录清理：同轮重连可再次请求（memberInvokeRound 不驻留）', async () => {
    // 可门控 LLM：回合卡在生成中，保证断开前后的两次 invoke 落在同一「轮」内——
    // 若断开未清理配额，重连后的 invoke 会被「每人每轮 1 次」限流
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

    srv.player.emit('ai:invoke', {});
    await new Promise((r) => setTimeout(r, 120)); // 回合已启动、配额已记录

    srv.player.close(); // 完全离开（单连接）→ handleDisconnect 应清理配额记录
    await new Promise((r) => setTimeout(r, 120));

    const rejoined = await new Promise<Socket>((resolve, reject) => {
      const client = io(`http://127.0.0.1:${srv.port}`, {
        auth: { protocol: PROTOCOL_VERSION },
        transports: ['websocket'],
        reconnection: false,
        timeout: 5000,
      });
      client.on('connect', () => resolve(client));
      client.on('connect_error', reject);
    });
    const feed = collect(rejoined);
    const ack = await new Promise<{ ok: boolean }>((resolve) =>
      rejoined.emit(
        'room:join',
        {
          inviteCode: srv.inviteCode,
          name: '阿探',
          wantRole: 'player',
          memberId: srv.playerMemberId,
        },
        resolve,
      ),
    );
    expect(ack.ok).toBe(true);

    rejoined.emit('ai:invoke', {}); // 同一轮：配额已清理 → 放行（而非 E-ROOM-01 限流）
    await new Promise((r) => setTimeout(r, 120));
    expect(feed.errors).toHaveLength(0);

    release(); // 回合 1 完成 → 回合 2（重连后的 invoke）执行
    await waitFor(() => feed.dones.length >= 2, 4000, '两轮回合完成');
    expect(feed.errors).toHaveLength(0);
    rejoined.close();
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

// ---- damage/heal 闭环 E2E（T-M8-03，FR-25 / G-M8 门禁）----

describe('damage 闭环 E2E（T-M8-03 / G-M8）', () => {
  it('5e 房：AI 指令 → 服务端掷骰 DiceMsg → 状态板 HP 变更（广播+落盘）→ 审计回放零失配', async () => {
    const srv = await startAiServer(
      [
        { delta: '哥布林挥刀砍来。\n' },
        { directive: { op: 'damage', target: 'pc:alice', expr: '1d6+2', label: '弯刀' } },
        { delta: '\n鲜血溅出。' },
        { stop: true },
        { delta: '你踉跄后退。' },
      ],
      { rulebook: 'dnd5e' },
    );
    const states: Array<{
      version: number;
      pcs: Record<string, { sheet: { hp: { current: number; max: number } } }>;
    }> = [];
    srv.host.on(
      'state:broadcast',
      (p: {
        stateBoard: {
          version: number;
          pcs: Record<string, { sheet: { hp: { current: number; max: number } } }>;
        };
      }) => states.push(p.stateBoard),
    );
    const hostFeed = collect(srv.host);
    const playerFeed = collect(srv.player);

    srv.player.emit('msg:send', { type: 'ic', content: '我冲向哥布林。' });
    await waitFor(() => hostFeed.dones.length >= 2, 4000, '两次 narration:done');

    // 效果骰恰好一颗：expr 原样、无判定记录（audit-first 由 recordDice 落流水）
    const dice = hostFeed.msgs.filter((m) => m.type === 'dice');
    expect(dice).toHaveLength(1);
    const roll = (dice[0] as { roll: { expr: string; total: number; check?: unknown } }).roll;
    expect(roll.expr).toBe('1d6+2');
    expect(roll.check ?? null).toBeNull(); // 效果骰无判定记录（消息体缺省该字段）

    // 回注含 HP 前后值；状态板广播 HP = 22 − total（clamp 前后一致：total ≤ 22 不触边）
    const system = hostFeed.msgs.filter(
      (m) => m.type === 'system' && m.subtype === 'ai_directive_result',
    );
    expect(system).toHaveLength(1);
    expect((system[0] as { content: string }).content).toContain(
      `【伤害】爱丽丝（弯刀）：1d6+2 → ${roll.total}，HP 22 → ${22 - roll.total}`,
    );
    const hit = states.find((b) => b.pcs.alice?.sheet.hp.current === 22 - roll.total);
    expect(hit).toBeDefined();

    // 落盘验证：state.json 已持久化新 HP（数值权威在盘不在内存）
    const room = await findByInviteCode(srv.layout, srv.inviteCode);
    expect(room).not.toBeNull();
    const board = await readStateBoard(srv.layout, room!.id, room!.activeSessionId!);
    expect(board.pcs.alice?.sheet).toMatchObject({ hp: { current: 22 - roll.total, max: 22 } });

    // 审计回放：伤害骰与检定骰同一通道，重算零失配（G-M8「E2E 剧本回放」项）
    const report = await replayAuditFile(srv.layout.auditDiceFile);
    expect(report.total).toBeGreaterThanOrEqual(1);
    expect(report.mismatches).toEqual([]);

    expect(playerFeed.errors).toHaveLength(0);
    expect(hostFeed.errors).toHaveLength(0);
    await srv.cleanup();
  });

  it('COC 房收到 damage → E-AI-01 防呆：不掷骰、状态板不变、玩家无感', async () => {
    const srv = await startAiServer([
      { delta: '哥布林挥刀。\n' },
      { directive: { op: 'damage', target: 'pc:alice', expr: '1d6+2' } },
      { delta: '\n但卡不是 5e 卡。' },
    ]);
    const states: unknown[] = [];
    srv.host.on('state:broadcast', (p: unknown) => states.push(p));
    const hostFeed = collect(srv.host);
    const playerFeed = collect(srv.player);

    srv.player.emit('msg:send', { type: 'ic', content: '我挨了一刀。' });
    await waitFor(() => hostFeed.dones.length >= 1, 4000, '本段 narration:done');

    expect(hostFeed.msgs.some((m) => m.type === 'dice')).toBe(false);
    expect(states).toHaveLength(0);
    expect(hostFeed.errors.some((e) => e.code === 'E-AI-01')).toBe(true);
    expect(playerFeed.errors).toHaveLength(0); // E-AI-01 玩家无感
    await srv.cleanup();
  });
});
