import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, type Message } from '@behindveil/shared';
import { createDataLayout, type DataLayout } from '../adapters/storage/layout.js';
import { JsonlStore } from '../adapters/storage/jsonl-store.js';
import { createRoom, readRoomFile } from '../domain/session/rooms.js';
import { readSession } from '../domain/session/sessions.js';
import { registerHostRoutes } from './http/host.js';
import { attachGateway, type GatewayHandle } from './socket.js';

/**
 * T-M1-03/05/06/07/08：Socket.IO 网关集成测试（TDD §4/§8）。
 * 真实 socket.io-client 打到本地监听端口，覆盖：握手校验（协议版本）、
 * 白名单/非法 payload 断连、进房身份（hostToken/memberId 重连）、满员、
 * msg:send 路由（ic/ooc all/host/whisper）、限速、开团、断线补发与 leave 清理。
 */

const settings = {
  provider: 'openai-compat',
  model: 'deepseek-chat',
  temperature: 0.7,
  maxHistoryMessages: 40,
  worldBookBudgetTokens: 2000,
  scanDepth: 4,
};

interface JoinAck {
  ok: boolean;
  roomId?: string;
  memberId?: string;
  role?: string;
  activeSessionId?: string | null;
  lastSeq?: number;
  members?: Array<{ id: string; name: string; role: string }>;
  code?: string;
  message?: string;
}

interface AppError {
  code: string;
  message: string;
}

const created: string[] = [];
let dataDir = '';
let layout: DataLayout;
let app: FastifyInstance;
let gateway: GatewayHandle;
let port = 0;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'bv-socket-'));
  created.push(dataDir);
  layout = createDataLayout(dataDir);

  app = Fastify({ logger: false });
  gateway = attachGateway(app, { layout, initialSeqs: new Map() });
  registerHostRoutes(app, { gateway: () => gateway });
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
});

/** 清理带超时竞速（沙箱 rm 慢，单次数百毫秒会撞 hook 超时；见 worldbook/store.test.ts 同款说明） */
async function rmQuietly(dir: string): Promise<void> {
  await Promise.race([
    rm(dir, { recursive: true, force: true }).catch(() => undefined),
    new Promise((r) => setTimeout(r, 2_000)),
  ]);
}

afterAll(async () => {
  await gateway.close();
  await app.close();
  await Promise.all(created.splice(0).map((dir) => rmQuietly(dir)));
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function connect(auth: Record<string, unknown> = { protocol: PROTOCOL_VERSION }): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const client = io(`http://127.0.0.1:${port}`, {
      auth,
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

function join(client: Socket, payload: Record<string, unknown>): Promise<JoinAck> {
  return new Promise((resolve) => client.emit('room:join', payload, resolve));
}

/** T-M5-05：开团前置是模组包存在——按需放置最小合法包（manifest + 三件套） */
async function placeModule(moduleId: string, rulebook: 'coc7' | 'dnd5e' = 'coc7'): Promise<void> {
  const dir = path.join(layout.modulesDir, moduleId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      id: moduleId,
      name: moduleId,
      version: '1.0.0',
      rulebook,
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
        extensions: { aidle: { rulebook } },
      },
    }),
  );
  await writeFile(path.join(dir, 'worldbook.json'), JSON.stringify({ entries: [] }));
  await writeFile(
    path.join(dir, 'init-state.json'),
    JSON.stringify({ scene: { name: '', time: '', publicDesc: '' } }),
  );
}

async function startSession(
  client: Socket,
  moduleId = 'mod-1',
  rulebook: 'coc7' | 'dnd5e' = 'coc7',
): Promise<{ ok: boolean; session?: { id: string }; message?: string }> {
  await placeModule(moduleId, rulebook);
  return new Promise((resolve) => client.emit('session:start', { moduleId, settings }, resolve));
}

function waitBroadcast(client: Socket, ms = 3000): Promise<{ msg: Message }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('msg:broadcast');
      reject(new Error('等待 msg:broadcast 超时'));
    }, ms);
    client.once('msg:broadcast', (payload: { msg: Message }) => {
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

async function expectNoBroadcast(client: Socket, ms = 400): Promise<void> {
  let seen = false;
  const onMsg = (): void => {
    seen = true;
  };
  client.on('msg:broadcast', onMsg);
  await sleep(ms);
  client.off('msg:broadcast', onMsg);
  expect(seen, '不应收到 msg:broadcast').toBe(false);
}

/** 建房 + Host 进房 + 开团，返回 inviteCode/hostToken/host 连接与会话 */
async function setupLiveRoom(roomName = '活跃房', rulebook: 'coc7' | 'dnd5e' = 'coc7') {
  const room = await createRoom(layout, { name: roomName });
  const host = await connect();
  const hostAck = await join(host, {
    inviteCode: room.inviteCode,
    hostToken: room.hostToken,
    name: 'KP',
  });
  if (!hostAck.ok) throw new Error(`Host 进房失败：${hostAck.message}`);
  const started = await startSession(host, rulebook === 'dnd5e' ? 'mod-5e' : 'mod-1', rulebook);
  if (!started.ok) throw new Error(`开团失败：${started.message}`);
  return { room, host, hostAck, sessionId: started.session?.id as string };
}

describe('握手校验（AsyncAPI「握手三校验」之一）', () => {
  it('协议版本不匹配 → 连接被拒（protocol-mismatch）', async () => {
    await expect(connect({ protocol: '9.9.9' })).rejects.toThrow(/protocol-mismatch/);
  });

  it('非白名单事件 → 服务端直接断连（防伪造事件注入）', async () => {
    const client = await connect();
    const closed = new Promise<string>((resolve) => client.once('disconnect', resolve));
    client.emit('hacked', { x: 1 });
    expect(await closed).toBe('io server disconnect');
  });

  it('白名单内但 payload 非法 → 断连，不回业务错误', async () => {
    const client = await connect();
    const closed = new Promise<string>((resolve) => client.once('disconnect', resolve));
    client.emit('room:join', { bad: true });
    expect(await closed).toBe('io server disconnect');
  });

  it('M2+ 事件（dice:roll）payload 合法：暂不处理，也不断连', async () => {
    const client = await connect();
    client.emit('dice:roll', { expr: '1d100' });
    await sleep(200);
    expect(client.connected).toBe(true);
    client.close();
  });
});

describe('room:join（T-M1-03，开放问题①）', () => {
  it('无效邀请码：ack 失败 + error:app（E-ROOM-01）', async () => {
    const client = await connect();
    const errorPromise = waitError(client);
    const ack = await join(client, { inviteCode: 'ZZZZZZ', name: '路人' });
    expect(ack).toMatchObject({ ok: false, code: 'E-ROOM-01', message: '邀请码无效' });
    expect(await errorPromise).toMatchObject({ code: 'E-ROOM-01', message: '邀请码无效' });
    client.close();
  });

  it('建房者出示 hostToken → Host 身份，ack 带回名册', async () => {
    const room = await createRoom(layout, { name: 'A' });
    const client = await connect();

    const ack = await join(client, {
      inviteCode: room.inviteCode,
      hostToken: room.hostToken,
      name: 'KP',
    });

    expect(ack.ok).toBe(true);
    expect(ack.role).toBe('host');
    expect(ack.activeSessionId ?? null).toBeNull();
    expect(ack.members?.map((m) => m.name)).toEqual(['KP']);
    client.close();
  });

  it('不出示 hostToken → 按 wantRole 加入（D-02：Host 不可申请）', async () => {
    const room = await createRoom(layout, { name: 'B' });
    const client = await connect();

    const player = await join(client, { inviteCode: room.inviteCode, name: '阿珂' });
    expect(player.role).toBe('player');

    const client2 = await connect();
    const observer = await join(client2, {
      inviteCode: room.inviteCode,
      name: '围观',
      wantRole: 'observer',
    });
    expect(observer.role).toBe('observer');
    client.close();
    client2.close();
  });

  it('memberId 重连复用身份', async () => {
    const room = await createRoom(layout, { name: 'C' });
    const first = await connect();
    const ack1 = await join(first, { inviteCode: room.inviteCode, name: '阿珂' });
    first.close();

    const second = await connect();
    const ack2 = await join(second, {
      inviteCode: room.inviteCode,
      name: '阿珂',
      memberId: ack1.memberId,
    });
    expect(ack2.ok).toBe(true);
    expect(ack2.memberId).toBe(ack1.memberId);
    second.close();
  });

  it('Host 凭 memberId 重连但不出示 hostToken → 不得冒领 Host（新建成员）', async () => {
    const room = await createRoom(layout, { name: 'D' });
    const first = await connect();
    const ack1 = await join(first, {
      inviteCode: room.inviteCode,
      hostToken: room.hostToken,
      name: 'KP',
    });
    expect(ack1.role).toBe('host');
    first.close();

    const second = await connect();
    const ack2 = await join(second, {
      inviteCode: room.inviteCode,
      name: 'KP',
      memberId: ack1.memberId,
    });
    expect(ack2.role).toBe('player');
    expect(ack2.memberId).not.toBe(ack1.memberId);
    second.close();
  });

  it('房间满员（在线数达 memberLimit）→ E-ROOM-01 房间已满', async () => {
    const room = await createRoom(layout, { name: '小屋', memberLimit: 1 });
    const first = await connect();
    const ack1 = await join(first, { inviteCode: room.inviteCode, name: 'A' });
    expect(ack1.ok).toBe(true);

    const second = await connect();
    const ack2 = await join(second, { inviteCode: room.inviteCode, name: 'B' });
    expect(ack2).toMatchObject({ ok: false, code: 'E-ROOM-01', message: '房间已满' });
    first.close();
    second.close();
  });
});

describe('session:start（T-M1-07）', () => {
  it('未加入房间 → ack 失败', async () => {
    const client = await connect();
    const ack = await startSession(client);
    expect(ack).toMatchObject({ ok: false, message: '尚未加入房间' });
    client.close();
  });

  it('非 Host → E-ROOM-01 仅 Host 可开团', async () => {
    const room = await createRoom(layout, { name: 'E' });
    const client = await connect();
    await join(client, { inviteCode: room.inviteCode, name: '阿珂' });

    const ack = await startSession(client);

    expect(ack).toMatchObject({ ok: false, message: '仅 Host 可开团' });
    client.close();
  });

  it('Host 开团：ack ok、session 落盘、全房广播会话开始系统消息', async () => {
    const room = await createRoom(layout, { name: 'F' });
    const host = await connect();
    await join(host, { inviteCode: room.inviteCode, hostToken: room.hostToken, name: 'KP' });
    const notice = waitBroadcast(host);

    const ack = await startSession(host, 'mod-疯狂山脉');

    expect(ack.ok).toBe(true);
    expect(ack.session?.id).toMatch(/^s_/);
    const broadcast = await notice;
    expect(broadcast.msg).toMatchObject({ type: 'system', subtype: 'notice' });
    if (broadcast.msg.type === 'system') {
      expect(broadcast.msg.content).toContain('mod-疯狂山脉');
    }

    const session = await readSession(layout, room.id, ack.session?.id as string);
    expect(session?.moduleRef).toBe('mod-疯狂山脉');
    const roomAfter = await readRoomFile(layout, room.id);
    expect(roomAfter?.activeSessionId).toBe(ack.session?.id);
    host.close();
  });
});

describe('msg:send 主链路（T-M1-05/06）', () => {
  it('未加入房间发消息 → error:app', async () => {
    const client = await connect();
    client.emit('msg:send', { type: 'ic', content: 'hello' });
    expect(await waitError(client)).toMatchObject({ code: 'E-ROOM-01' });
    client.close();
  });

  it('观察者不能发言（TDD §4.1 msg:send 权限 player+）', async () => {
    const room = await createRoom(layout, { name: 'G' });
    const client = await connect();
    await join(client, { inviteCode: room.inviteCode, name: '围观', wantRole: 'observer' });

    client.emit('msg:send', { type: 'ic', content: 'hello' });

    expect(await waitError(client)).toMatchObject({ message: '观察者视角不能发言' });
    client.close();
  });

  it('未开团不能发言', async () => {
    const room = await createRoom(layout, { name: 'H' });
    const client = await connect();
    await join(client, { inviteCode: room.inviteCode, name: '阿珂' });

    client.emit('msg:send', { type: 'ic', content: 'hello' });

    expect(await waitError(client)).toMatchObject({ message: '尚未开团，暂不能发言' });
    client.close();
  });

  it('IC 消息：全房广播（seq 连续）并落盘', async () => {
    const { room, host, sessionId } = await setupLiveRoom();
    const player = await connect();
    const joinNotice = waitBroadcast(host); // player 的 join 系统消息先到
    await join(player, { inviteCode: room.inviteCode, name: '阿珂' });
    const joinMsg = await joinNotice;
    expect(joinMsg.msg).toMatchObject({ type: 'system', subtype: 'join' });

    const icToHost = waitBroadcast(host);
    player.emit('msg:send', { type: 'ic', content: '我推开大门' });
    const toHost = await icToHost;
    expect(toHost.msg).toMatchObject({ type: 'ic', content: '我推开大门' });
    expect(toHost.msg.seq).toBe(joinMsg.msg.seq + 1);

    const toPlayer = await waitBroadcast(player);
    expect(toPlayer.msg.seq).toBe(toHost.msg.seq);

    const { records } = await new JsonlStore(layout.messagesFile(room.id, sessionId)).readAll();
    expect(records.length).toBeGreaterThanOrEqual(3); // notice + join + ic
    host.close();
    player.close();
  });

  it('whisper（带 targetId）：目标/Host/发送者收到，旁观者不收', async () => {
    const { room, host } = await setupLiveRoom('密语房');
    // handleJoin 在 join 广播完成后才回 ack，join 消息无需另行消化
    const sender = await connect();
    const senderAck = await join(sender, { inviteCode: room.inviteCode, name: '阿珂' });
    const target = await connect();
    const targetAck = await join(target, { inviteCode: room.inviteCode, name: '老王' });
    const bystander = await connect();
    await join(bystander, { inviteCode: room.inviteCode, name: '围观', wantRole: 'observer' });

    const gotHost = waitBroadcast(host);
    const gotTarget = waitBroadcast(target);
    const gotSender = waitBroadcast(sender);
    sender.emit('msg:send', { type: 'ooc', content: '悄悄话', targetId: targetAck.memberId });

    for (const got of [await gotHost, await gotTarget, await gotSender]) {
      expect(got.msg).toMatchObject({
        type: 'ooc',
        visibility: 'whisper',
        senderId: senderAck.memberId,
        targetId: targetAck.memberId,
      });
    }
    await expectNoBroadcast(bystander);
    host.close();
    sender.close();
    target.close();
    bystander.close();
  });

  it('OOC visibility=host：仅 Host 与发送者收到', async () => {
    const { room, host } = await setupLiveRoom('密谈房');
    const sender = await connect();
    const senderAck = await join(sender, { inviteCode: room.inviteCode, name: '阿珂' });
    const bystander = await connect();
    await join(bystander, { inviteCode: room.inviteCode, name: '路人' });

    const gotHost = waitBroadcast(host);
    const gotSender = waitBroadcast(sender);
    sender.emit('msg:send', { type: 'ooc', content: 'KP 密语', visibility: 'host' });

    for (const got of [await gotHost, await gotSender]) {
      expect(got.msg).toMatchObject({
        type: 'ooc',
        visibility: 'host',
        senderId: senderAck.memberId,
      });
    }
    await expectNoBroadcast(bystander);
    host.close();
    sender.close();
    bystander.close();
  });

  it('限速：10 条 / 30 秒 / 人，超出 → error:app 且不落盘', async () => {
    const { room, host, sessionId } = await setupLiveRoom('限速房');
    const sender = await connect();
    await join(sender, { inviteCode: room.inviteCode, name: '话痨' });

    for (let i = 0; i < 10; i++) sender.emit('msg:send', { type: 'ic', content: `消息 ${i}` });
    sender.emit('msg:send', { type: 'ic', content: '第 11 条' });

    const err = await waitError(sender, 5000);
    expect(err.message).toBe('发送太频繁，请稍后再试');

    await sleep(500); // 等串行队列清空
    const { records } = await new JsonlStore(layout.messagesFile(room.id, sessionId)).readAll();
    const contents = records.map((r) => (r as { content?: string }).content ?? '');
    expect(contents).not.toContain('第 11 条');
    host.close();
    sender.close();
  });

  it('TC-FR-02-001 故障变体：写盘失败 → 不广播、回 error:app（E-SRV-01）且 seq 不留空洞', async () => {
    const { room, host, sessionId } = await setupLiveRoom('写盘失败房');
    const spy = vi
      .spyOn(JsonlStore.prototype, 'append')
      .mockRejectedValueOnce(new Error('EIO: 模拟磁盘满'));

    const errPromise = waitError(host);
    host.emit('msg:send', { type: 'ic', content: '会失败的消息' });
    expect(await errPromise, 'WAP：失败消息不广播，回业务错误').toMatchObject({ code: 'E-SRV-01' });
    spy.mockRestore();

    // 恢复后消息正常广播，并复用失败消息未占用的 seq
    const recovered = waitBroadcast(host);
    host.emit('msg:send', { type: 'ic', content: '恢复后的消息' });
    const got = await recovered;
    expect(got.msg.type === 'ic' ? got.msg.content : '').toBe('恢复后的消息');
    expect(got.msg.seq).toBe(2); // notice=1；失败的那条没落盘也没占 seq

    const { records } = await new JsonlStore(layout.messagesFile(room.id, sessionId)).readAll();
    expect(records.map((r) => (r as { seq: number }).seq)).toEqual([1, 2]);
    host.close();
  });
});

describe('断线清理与补发（T-M1-08）', () => {
  it('成员断开：广播 leave 系统消息', async () => {
    const { room, host } = await setupLiveRoom('断线房');
    const player = await connect();
    const joinNotice = waitBroadcast(host);
    await join(player, { inviteCode: room.inviteCode, name: '阿珂' });
    await joinNotice; // join 消息已广播

    const leaveNotice = waitBroadcast(host, 5000);
    player.disconnect();
    const leaveMsg = await leaveNotice;
    expect(leaveMsg.msg).toMatchObject({ type: 'system', subtype: 'leave' });
    if (leaveMsg.msg.type === 'system') {
      expect(leaveMsg.msg.content).toContain('阿珂');
    }
    host.close();
  });

  it('同一成员多连接：断开其一不算离开', async () => {
    const { room, host } = await setupLiveRoom('多连房');
    const conn1 = await connect();
    const ack = await join(conn1, { inviteCode: room.inviteCode, name: '阿珂' });
    const conn2 = await connect();
    await join(conn2, {
      inviteCode: room.inviteCode,
      name: '阿珂',
      memberId: ack.memberId,
    });

    conn1.disconnect();
    await expectNoBroadcast(host, 500); // 另一连接仍在线，不算离开

    const leaveNotice = waitBroadcast(host, 5000);
    conn2.disconnect();
    const leaveMsg = await leaveNotice;
    expect(leaveMsg.msg).toMatchObject({ type: 'system', subtype: 'leave' });
    host.close();
  });

  it('进房带 lastSeq：服务端补发缺口（升序）', async () => {
    const { room, host } = await setupLiveRoom('补发房');
    host.emit('msg:send', { type: 'ic', content: '第一条' });
    host.emit('msg:send', { type: 'ic', content: '第二条' });
    await sleep(300); // 等两条 IC 落盘

    const newcomer = await connect();
    const collected: Message[] = [];
    newcomer.on('msg:broadcast', (p: { msg: Message }) => collected.push(p.msg));
    const ack = await join(newcomer, { inviteCode: room.inviteCode, name: '新人', lastSeq: 0 });
    expect(ack.ok).toBe(true);
    await sleep(400); // 等补发 + join 广播

    const icSeqs = collected
      .filter((m) => m.type === 'ic')
      .map((m) => m.seq)
      .sort((a, b) => a - b);
    expect(icSeqs).toEqual([2, 3]); // notice=1，IC=2、3
    newcomer.close();
    host.close();
  });
});

describe('kp:previewPrompt（T-M2-05，FR-13）', () => {
  interface PromptPreviewPayload {
    pipeline: {
      stages: Array<{ name: string; tokenCount: number }>;
      messages: Array<{ role: string; content: string }>;
    };
  }

  function waitPreview(client: Socket, ms = 3000): Promise<PromptPreviewPayload> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        client.off('kp:promptPreview');
        reject(new Error('等待 kp:promptPreview 超时'));
      }, ms);
      client.once('kp:promptPreview', (payload: PromptPreviewPayload) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });
  }

  it('Host 请求 → 定向回 kp:promptPreview，携带七阶段 trace', async () => {
    const { host } = await setupLiveRoom('预览房');
    const previewPromise = waitPreview(host);
    host.emit('kp:previewPrompt', {});

    const payload = await previewPromise;
    expect(payload.pipeline.stages.map((s) => s.name.slice(0, 2))).toEqual([
      'S1',
      'S2',
      'S3',
      'S4',
      'S5',
      'S6',
      'S7',
    ]);
    expect(payload.pipeline.messages.length).toBeGreaterThan(0);
    host.close();
  });

  it('非 Host 请求被拒（E-ROOM-01）', async () => {
    const { room, host } = await setupLiveRoom('预览权限房');
    const player = await connect();
    await join(player, { inviteCode: room.inviteCode, name: '玩家' });
    // host 收不到 player 触发的回包，只可能收到 error:app
    const errorPromise = waitError(player);
    player.emit('kp:previewPrompt', {});

    expect(await errorPromise).toMatchObject({
      code: 'E-ROOM-01',
      message: '仅 Host 可预览 prompt',
    });
    player.close();
    host.close();
  });

  it('未开团 → E-ROOM-01', async () => {
    const room = await createRoom(layout, { name: '未开团预览房' });
    const host = await connect();
    await join(host, { inviteCode: room.inviteCode, hostToken: room.hostToken, name: 'KP' });

    const errorPromise = waitError(host);
    host.emit('kp:previewPrompt', {});

    expect(await errorPromise).toMatchObject({
      code: 'E-ROOM-01',
      message: '尚未开团，暂无 prompt 可预览',
    });
    host.close();
  });
});

describe('kpOnly 不泄露（TC-FR-07-012，TDD §8）', () => {
  interface PromptPreviewPayload {
    pipeline: {
      stages: Array<{ name: string }>;
      messages: Array<{ role: string; content: string }>;
    };
  }

  function waitPreview(client: Socket, ms = 3000): Promise<PromptPreviewPayload> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        client.off('kp:promptPreview');
        reject(new Error('等待 kp:promptPreview 超时'));
      }, ms);
      client.once('kp:promptPreview', (payload: PromptPreviewPayload) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });
  }

  it('kpOnly 内容仅出现在 Host 预览；玩家的广播流与预览请求均不可见', async () => {
    const { room, host } = await setupLiveRoom('kpOnly房');
    // 房间级手编世界书写入 kpOnly 模组真相（key 为空 → 扫描层恒命中）
    const SECRET = '模组真相：秘宝藏在座钟夹层。';
    await mkdir(path.join(dataDir, 'rooms', room.id), { recursive: true });
    await writeFile(
      layout.worldbookFile(room.id),
      JSON.stringify({
        entries: [
          {
            uid: 1,
            key: [],
            keysecondary: [],
            selectiveLogic: 0,
            content: SECRET,
            position: 'after_char',
            order: 0,
            weight: 100,
            constant: false,
            disabled: false,
            extensions: { kpOnly: true },
          },
        ],
      }),
      'utf8',
    );

    // 玩家进房，记录其收到的所有广播事件（含 msg:broadcast 与系统事件）
    const player = await connect();
    await join(player, { inviteCode: room.inviteCode, name: '玩家' });
    const received: Array<{ event: string; payload: unknown }> = [];
    player.onAny((event: string, ...args: unknown[]) => {
      received.push({ event, payload: args });
    });

    // Host 预览：kpOnly 内容对 Host 可见（FR-13 是其唯一出口）
    const previewPromise = waitPreview(host);
    host.emit('kp:previewPrompt', {});
    const preview = await previewPromise;
    expect(preview.pipeline.messages.map((m) => m.content).join('\n')).toContain(SECRET);

    // 玩家视角：普通消息广播照常，但任何到达玩家的事件都不携带 kpOnly 内容
    // （导出面 M5 落地时需按同一口径复验）
    const broadcastPromise = waitBroadcast(player);
    host.emit('msg:send', { type: 'ic', content: '日常发言' });
    await broadcastPromise;
    await sleep(300); // 留出潜在其他事件到达的时间窗
    expect(JSON.stringify(received)).not.toContain(SECRET);

    // 玩家主动请求预览 → E-ROOM-01 拒绝
    const errorPromise = waitError(player);
    player.emit('kp:previewPrompt', {});
    expect(await errorPromise).toMatchObject({
      code: 'E-ROOM-01',
      message: '仅 Host 可预览 prompt',
    });

    player.close();
    host.close();
  });
});

describe('规则书接线（T-M7-04，设计文档 v2 §5.1）', () => {
  it('5e 模组开团 → 玩家骰走 dnd5e 判定（kind=ability、DC 后缀）', async () => {
    const { host } = await setupLiveRoom('五版房', 'dnd5e');
    const broadcast = waitBroadcast(host);
    host.emit('dice:roll', { expr: '1d20+5>=13' });
    const { msg } = await broadcast;

    expect(msg.type).toBe('dice');
    if (msg.type !== 'dice') throw new Error('期望骰子消息');
    expect(msg.roll.check).toMatchObject({
      rulebook: 'dnd5e',
      kind: 'ability',
      op: '>=',
      target: 13,
    });
    // 属性检定在 attack_only 下不触发面值规则：判定即 total 与 DC 的比较
    expect(msg.roll.check?.outcome).toBe(msg.roll.total >= 13 ? 'success' : 'fail');
    host.close();
  });

  it('一房一规则书：COC 活跃会话在，换 5e 模组开团 → 拒绝（E-MOD-01）', async () => {
    const { host, room, sessionId } = await setupLiveRoom('混搭房', 'coc7');
    const started = await startSession(host, 'mod-5e', 'dnd5e');
    expect(started).toMatchObject({ ok: false, code: 'E-MOD-01' });

    // 拒绝后活跃会话不变，房内状态仍然是原来那个 COC 会话
    const after = await readRoomFile(layout, room.id);
    expect(after?.activeSessionId).toBe(sessionId);
    host.close();
  });

  it('同规则书换模组可正常开新场次（不误伤连载复播）', async () => {
    const { host } = await setupLiveRoom('同版房', 'dnd5e');
    const second = await startSession(host, 'mod-5e-b', 'dnd5e');
    expect(second.ok).toBe(true);
    host.close();
  });
});

// ---- Host 转让/副 Host（T-M8-06，FR-26，设计 §5.5）----

describe('Host 转让（T-M8-06）', () => {
  it('REST 转让全链路：原 Host 即时失权、新 Host 即时获权、旧 token 失效、新 Host 凭 memberId 重连', async () => {
    const room = await createRoom(layout, { name: 'T8-转让' });
    const host = await connect();
    const hostAck = await join(host, {
      inviteCode: room.inviteCode,
      hostToken: room.hostToken,
      name: 'KP',
    });
    expect(hostAck.role).toBe('host');
    const alice = await connect();
    const aliceAck = await join(alice, { inviteCode: room.inviteCode, name: '爱丽丝' });

    const base = `http://127.0.0.1:${port}/rooms/${room.id}`;
    const res = await fetch(`${base}/host-transfer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostToken: room.hostToken, toMemberId: aliceAck.memberId }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ memberId: aliceAck.memberId });

    // presence 即时换位：原 Host 的 Host 专属动作（开团）被拒
    const denied = await startSession(host, 'mod-t8a');
    expect(denied.ok).toBe(false);

    // 新 Host 同一连接即时获权（无需重连）
    const granted = await startSession(alice, 'mod-t8a');
    expect(granted.ok).toBe(true);

    // 旧 token 已轮换失效：再拿它做任何 Host 操作 → 401
    const stale = await fetch(`${base}/host-transfer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostToken: room.hostToken, toMemberId: hostAck.memberId }),
    });
    expect(stale.status).toBe(401);

    // hostAuth='member'：新 Host 断线重连凭 memberId 恢复 Host（无需 token）
    alice.close();
    const again = await connect();
    const reAck = await join(again, {
      inviteCode: room.inviteCode,
      name: '爱丽丝',
      memberId: aliceAck.memberId,
    });
    expect(reAck.role).toBe('host');
    again.close();
    host.close();
  });

  it('非法转让：观察者/离线成员/不存在的成员 → 400 且身份不变', async () => {
    const room = await createRoom(layout, { name: 'T8-拒绝' });
    const host = await connect();
    const hostAck = await join(host, {
      inviteCode: room.inviteCode,
      hostToken: room.hostToken,
      name: 'KP',
    });
    const observer = await connect();
    const observerAck = await join(observer, {
      inviteCode: room.inviteCode,
      name: '围观',
      wantRole: 'observer',
    });
    const base = `http://127.0.0.1:${port}/rooms/${room.id}`;
    const post = (body: Record<string, unknown>): Promise<Response> =>
      fetch(`${base}/host-transfer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    expect(
      (await post({ hostToken: room.hostToken, toMemberId: observerAck.memberId })).status,
    ).toBe(400);
    expect(
      (
        await post({
          hostToken: room.hostToken,
          toMemberId: 'ghost-member',
        })
      ).status,
    ).toBe(400);
    // token 错误 → 401
    expect(
      (await post({ hostToken: 'wrong-token', toMemberId: observerAck.memberId })).status,
    ).toBe(401);

    // 原 Host 身份不变：仍可开团
    const session = await startSession(host, 'mod-t8b');
    expect(session.ok).toBe(true);
    expect(await readSession(layout, room.id, session.session?.id ?? '')).not.toBeNull();
    observer.close();
    host.close();
    void hostAck;
  });
});

describe('副 Host（T-M8-06，FR-26）', () => {
  it('副 Host 可状态编辑与快照（Host 掉线亦可代行），普通玩家仍被拒', async () => {
    const room = await createRoom(layout, { name: 'T8-副Host' });
    const host = await connect();
    await join(host, { inviteCode: room.inviteCode, hostToken: room.hostToken, name: 'KP' });
    const alice = await connect();
    const aliceAck = await join(alice, { inviteCode: room.inviteCode, name: '爱丽丝' });
    const carol = await connect();
    await join(carol, { inviteCode: room.inviteCode, name: '卡萝' });

    const session = await startSession(host, 'mod-t8c');
    expect(session.ok).toBe(true);

    // 普通玩家 state:update → 拒
    const denied = new Promise<AppError>((resolve) => {
      carol.once('error:app', (e: AppError) => resolve(e));
    });
    carol.emit('state:update', { patch: { facts: ['卡萝的编辑'] }, expectedVersion: 0 });
    expect(await denied).toMatchObject({ code: 'E-ROOM-01' });

    // Host 掉线（代行前提）：roomHostSockets 清空
    host.close();
    await sleep(200);

    // REST 设副 Host（hostToken 在 Host 手里，掉线不影响 REST 授权）
    const res = await fetch(`http://127.0.0.1:${port}/rooms/${room.id}/co-host`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostToken: room.hostToken, memberId: aliceAck.memberId }),
    });
    expect(res.status).toBe(200);

    // 副 Host 状态编辑：乐观锁写 → 成功广播（state:update 无 ack，以广播为准）
    const updated = new Promise<{ stateBoard: { version: number; facts: string[] } }>((resolve) => {
      alice.once('state:broadcast', (p: { stateBoard: { version: number; facts: string[] } }) =>
        resolve(p),
      );
    });
    alice.emit('state:update', { patch: { facts: ['副 Host 写入的事实'] }, expectedVersion: 0 });
    const board = await updated;
    expect(board.stateBoard.facts).toContain('副 Host 写入的事实');

    // 副 Host 快照：state_snapshot 消息入流
    const snapshotSeen = new Promise<void>((resolve) => {
      alice.once('msg:broadcast', (p: { msg: Message }) => {
        if (p.msg.type === 'state_snapshot') resolve();
      });
    });
    alice.emit('state:snapshot', {});
    await snapshotSeen;

    carol.close();
    alice.close();
  });

  it('撤销副 Host → 权限收回；观察者/离线成员设副 Host → 400', async () => {
    const room = await createRoom(layout, { name: 'T8-撤销' });
    const host = await connect();
    await join(host, { inviteCode: room.inviteCode, hostToken: room.hostToken, name: 'KP' });
    const alice = await connect();
    const aliceAck = await join(alice, { inviteCode: room.inviteCode, name: '爱丽丝' });
    const observer = await connect();
    const observerAck = await join(observer, {
      inviteCode: room.inviteCode,
      name: '围观',
      wantRole: 'observer',
    });
    await startSession(host, 'mod-t8d');

    const base = `http://127.0.0.1:${port}/rooms/${room.id}`;
    const put = (body: Record<string, unknown>): Promise<Response> =>
      fetch(`${base}/co-host`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    expect((await put({ hostToken: room.hostToken, memberId: observerAck.memberId })).status).toBe(
      400,
    );
    expect((await put({ hostToken: room.hostToken, memberId: 'ghost-member' })).status).toBe(400);

    expect((await put({ hostToken: room.hostToken, memberId: aliceAck.memberId })).status).toBe(
      200,
    );
    // 撤销（memberId=null）→ 200，随后 alice 的 state:update 被拒
    expect((await put({ hostToken: room.hostToken, memberId: null })).status).toBe(200);
    const denied = new Promise<AppError>((resolve) => {
      alice.once('error:app', (e: AppError) => resolve(e));
    });
    alice.emit('state:update', { patch: { facts: ['迟到的编辑'] }, expectedVersion: 0 });
    expect(await denied).toMatchObject({ code: 'E-ROOM-01' });

    observer.close();
    alice.close();
    host.close();
  });
});
