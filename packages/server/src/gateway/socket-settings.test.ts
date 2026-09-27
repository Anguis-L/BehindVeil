import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@behindveil/shared';
import { createDataLayout, type DataLayout } from '../adapters/storage/layout.js';
import { createMockLlm, type MockLlmAdapter, type MockScriptStep } from '../adapters/llm/mock.js';
import { createRoom } from '../domain/session/rooms.js';
import { createSession, updateSessionSettings } from '../domain/session/sessions.js';
import { attachGateway, type GatewayHandle } from './socket.js';

/**
 * T-M6-04 支撑：会话级设置真的喂给了 LLM（FR-13）。
 *
 * 端点本身（PATCH .../settings 的 400/404/200）在 gateway/http/rooms.test.ts 覆盖，
 * 这里钉的是**生效链路**——改完会话设置，下一次 LLM 请求的 temperature 就得是新值；
 * 装配常量只是会话设置缺失时的兜底。
 *
 * 目录清理：只关服务，不递归删临时目录（沙箱批量删除守卫会拦截并挂住钩子）。
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

const SCRIPT: MockScriptStep[] = [{ delta: '门后一片漆黑。' }];

let layout: DataLayout;
let app: FastifyInstance;
let gateway: GatewayHandle;
let mock: MockLlmAdapter;
let port = 0;

beforeAll(async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'bv-socket-settings-'));
  layout = createDataLayout(dataDir);
  mock = createMockLlm({ script: SCRIPT });
  app = Fastify({ logger: false });
  gateway = attachGateway(app, {
    layout,
    initialSeqs: new Map(),
    llm: mock,
    chat: { model: 'mock-model', temperature: 0.7, maxTokens: 2048 },
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

async function setupLiveRoom(roomName: string) {
  const room = await createRoom(layout, { name: roomName });
  const session = await createSession(layout, room.id, { moduleId: 'mod-metrics', settings });
  const host = await connect();
  await new Promise((resolve) =>
    host.emit(
      'room:join',
      { inviteCode: room.inviteCode, hostToken: room.hostToken, name: 'KP' },
      resolve,
    ),
  );
  return { room, host, sessionId: session.id };
}

/** 触发一次 AI 回合并等它收尾（narration:done 即本回合最后一次 LLM 请求已完成） */
async function runAiTurn(host: Socket): Promise<void> {
  const done = new Promise<void>((resolve) => host.once('narration:done', () => resolve()));
  host.emit('ai:invoke', {});
  await done;
}

describe('会话级设置 → LLM 请求（T-M6-04 支撑）', () => {
  it('temperature 取会话设置；改完下一次调用即生效，其余参数不受影响', async () => {
    const { host, sessionId, room } = await setupLiveRoom('设置生效房');

    await runAiTurn(host);
    expect(mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(mock.calls[0]?.temperature).toBe(0.7);
    expect(mock.calls[0]?.model).toBe('mock-model');

    // KP 控制台改会话设置（写回 session.json，端点侧行为见 rooms.test.ts）
    const updated = await updateSessionSettings(layout, room.id, sessionId, { temperature: 1.5 });
    expect(updated?.settings.temperature).toBe(1.5);

    await runAiTurn(host);
    const last = mock.calls[mock.calls.length - 1];
    expect(last?.temperature).toBe(1.5);
    expect(last?.model).toBe('mock-model');
    expect(last?.maxTokens).toBe(2048);
    host.close();
  });
});
