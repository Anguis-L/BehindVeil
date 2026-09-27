import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@behindveil/shared';
import { createDataLayout, type DataLayout } from '../adapters/storage/layout.js';
import { createMockLlm, type MockScriptStep } from '../adapters/llm/mock.js';
import { createRoom } from '../domain/session/rooms.js';
import { createSession } from '../domain/session/sessions.js';
import { attachGateway, type GatewayHandle } from './socket.js';
import { MetricsCollector } from '../observability/metrics.js';

/**
 * T-M6-03/05：房内实时指标 `kp:metrics` → `kp:metricsResult`（FR-13 / R-01 / R-02）。
 *
 * 与 `GET /metrics` 的分工：那个是全局 + 管理令牌，这个是会话级 + Host 身份
 * （前端不带 X-Admin-Token）。本文件钉三件事：Host 权限、非 Host 拒绝、以及
 * 埋点真的记到了数（骰子 / LLM 调用 / 指令成功率）。
 *
 * 目录清理：只关服务，不递归删临时目录（沙箱批量删除守卫会拦截并挂住钩子），
 * mkdtemp 落在系统临时区，由 OS 回收——与 export.test.ts 同一处理。
 */

const settings = {
  provider: 'openai-compat',
  model: 'deepseek-chat',
  temperature: 0.7,
  maxHistoryMessages: 40,
  worldBookBudgetTokens: 2000,
  scanDepth: 4,
  contextWindowTokens: 32_768,
  outputReserveTokens: 2_048,
};

/** Mock 剧本：两段纯叙事（本文件只关心埋点，检定闭环由 socket-ai.test.ts 覆盖） */
const SCRIPT: MockScriptStep[] = [{ delta: '门后一片漆黑。' }, { delta: '你摸到一张剪报。' }];

interface MetricsResult {
  sessionId: string;
  directives: { attempts: number; successes: number; rate: number };
  dice: { total: number; hidden: number };
  llm: {
    calls: number;
    failures: number;
    tokensIn: number;
    tokensOut: number;
    latencyMs: { p50: number; p95: number; max: number; avg: number };
  };
  cost: { estimatedCny: number };
}

interface AppError {
  code: string;
  message: string;
}

let layout: DataLayout;
let app: FastifyInstance;
let gateway: GatewayHandle;
let metrics: MetricsCollector;
let port = 0;

beforeAll(async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'bv-socket-metrics-'));
  layout = createDataLayout(dataDir);
  metrics = new MetricsCollector();
  app = Fastify({ logger: false });
  gateway = attachGateway(app, {
    layout,
    initialSeqs: new Map(),
    llm: createMockLlm({ script: SCRIPT }),
    chat: { model: 'mock-model', temperature: 0.7, maxTokens: 2048 },
    metrics,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
});

afterAll(async () => {
  await gateway.close();
  await app.close();
});

function connect(): Promise<Socket> {
  return new Promise((resolve, reject) => {
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
}

function join(client: Socket, payload: Record<string, unknown>): Promise<{ ok: boolean }> {
  return new Promise((resolve) => client.emit('room:join', payload, resolve));
}

/** 用 ai:invoke 触发 AI 回合（T-M3-06）：绕开 session:start 的模组装载校验（T-M5-05） */
function invokeAi(client: Socket): void {
  client.emit('ai:invoke', {});
}

function waitMetrics(client: Socket, ms = 3000): Promise<MetricsResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('kp:metricsResult');
      reject(new Error('等待 kp:metricsResult 超时'));
    }, ms);
    client.once('kp:metricsResult', (payload: MetricsResult) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function waitError(client: Socket, ms = 3000): Promise<AppError> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('error:app');
      reject(new Error('等待 error:app 超时'));
    }, ms);
    client.once('error:app', (payload: AppError) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/**
 * 建房 + Host 进房 + 开团。开团走领域层 createSession 而非 session:start：
 * 本文件只测指标，不测模组装载（T-M5-05 的 E-MOD-01 分支由 socket.test.ts 覆盖）。
 */
async function setupLiveRoom(roomName = '指标房') {
  const created = await createRoom(layout, { name: roomName });
  const session = await createSession(layout, created.id, { moduleId: 'mod-metrics', settings });
  const host = await connect();
  await join(host, {
    inviteCode: created.inviteCode,
    hostToken: created.hostToken,
    name: 'KP',
  });
  return { room: created, host, sessionId: session.id };
}

describe('kp:metrics（T-M6-03/05，FR-13）', () => {
  it('未加入房间 → E-ROOM-01', async () => {
    const client = await connect();
    const errorPromise = waitError(client);
    client.emit('kp:metrics', {});
    expect(await errorPromise).toMatchObject({ code: 'E-ROOM-01', message: '尚未加入房间' });
    client.close();
  });

  it('非 Host 被拒（E-ROOM-01），且不回指标', async () => {
    const { room: live } = await setupLiveRoom('指标权限房');
    const player = await connect();
    await join(player, { inviteCode: live.inviteCode, name: '玩家' });

    const errorPromise = waitError(player);
    const metricsPromise = waitMetrics(player, 600).catch(() => null);
    player.emit('kp:metrics', {});

    expect(await errorPromise).toMatchObject({
      code: 'E-ROOM-01',
      message: '仅 Host 可查看实时指标',
    });
    expect(await metricsPromise).toBeNull();
    player.close();
  });

  it('未开团 → E-ROOM-01', async () => {
    const notStarted = await createRoom(layout, { name: '未开团指标房' });
    const host = await connect();
    await join(host, {
      inviteCode: notStarted.inviteCode,
      hostToken: notStarted.hostToken,
      name: 'KP',
    });

    const errorPromise = waitError(host);
    host.emit('kp:metrics', {});
    expect(await errorPromise).toMatchObject({
      code: 'E-ROOM-01',
      message: '尚未开团，暂无指标可看',
    });
    host.close();
  });

  it('Host 请求 → 回本会话指标，形状与前端契约一致', async () => {
    const { host, sessionId } = await setupLiveRoom('指标会话房');
    // 先掷一次暗骰：验证骰子埋点（total / hidden）
    host.emit('dice:roll', { expr: '1d100', hidden: true });
    // 再走一次 AI 回合：验证 LLM 埋点（调用次数 / 延迟）
    const done = new Promise<void>((resolve) => host.once('narration:done', () => resolve()));
    invokeAi(host);
    await done;

    const metricsPromise = waitMetrics(host, 8000);
    host.emit('kp:metrics', { sessionId });
    const payload = await metricsPromise;

    expect(Object.keys(payload).sort()).toEqual(['cost', 'dice', 'directives', 'llm', 'sessionId']);
    expect(payload.sessionId).toBe(sessionId);
    expect(payload.dice.total).toBeGreaterThanOrEqual(1); // 玩家暗骰 + 检定骰
    expect(payload.dice.hidden).toBe(1);
    expect(payload.llm.calls).toBeGreaterThanOrEqual(1);
    expect(payload.llm.latencyMs.max).toBeGreaterThanOrEqual(0);
    expect(payload.llm.latencyMs.p95).toBeGreaterThanOrEqual(payload.llm.latencyMs.p50);
    expect(typeof payload.cost.estimatedCny).toBe('number');
    expect(payload.directives.attempts).toBeGreaterThanOrEqual(0);
    host.close();
  });

  it('缺省会话 = 当前活跃会话；显式 sessionId 可指定', async () => {
    const { host, sessionId } = await setupLiveRoom('缺省会话房');

    const byDefault = waitMetrics(host);
    host.emit('kp:metrics', {});
    expect((await byDefault).sessionId).toBe(sessionId);

    const byExplicit = waitMetrics(host);
    host.emit('kp:metrics', { sessionId });
    expect((await byExplicit).sessionId).toBe(sessionId);
    host.close();
  });

  it('显式指定他房会话 → E-ROOM-01（房内事件不得跨房读指标）', async () => {
    const { host } = await setupLiveRoom('跨房房');
    const otherRoom = await createRoom(layout, { name: '他房' });
    const otherSession = await createSession(layout, otherRoom.id, {
      moduleId: 'mod-metrics',
      settings,
    });

    const errorPromise = waitError(host);
    host.emit('kp:metrics', { sessionId: otherSession.id });
    expect(await errorPromise).toMatchObject({ code: 'E-ROOM-01', message: '会话不存在' });
    host.close();
  });

  it('埋点进的是装配根传入的同一实例（GET /metrics 与房内同源）', async () => {
    const { host, sessionId } = await setupLiveRoom('同源房');
    host.emit('dice:roll', { expr: '1d100' });
    await new Promise((r) => setTimeout(r, 300));

    const snapshot = metrics.snapshot({ attempts: 0, successes: 0 });
    const sessionSnapshot = metrics.sessionSnapshot(sessionId, { attempts: 0, successes: 0 });
    expect(snapshot.dice.total).toBeGreaterThanOrEqual(sessionSnapshot.dice.total);
    expect(sessionSnapshot.dice.total).toBeGreaterThanOrEqual(1);
    host.close();
  });
});
