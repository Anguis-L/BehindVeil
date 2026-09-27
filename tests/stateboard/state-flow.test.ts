import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { io, type Socket } from 'socket.io-client';

/**
 * T-M5-04/06 集成：状态板写路径与乐观锁（TC-FR-09-001~003，FR-09）+ PC 声明装配
 * （T-M5-04，SDD §5.1）。走真实服务端（Fastify + Socket.IO 网关 + 文件存储）：
 *   - state:update 命中 → version+1 → state:broadcast 全员一致（TC-FR-09-002）；
 *   - expectedVersion 过期 → E-ST-01 拒绝 + 广播最新版（TC-FR-09-001）；
 *   - player 的 state:update 被拒（TC-FR-09-003 的 socket 侧）；
 *   - 开团前 REST 声明的 PC（速建表）随 createSession 进状态板初始 pcs。
 */

const SERVER_DIST = fileURLToPath(new URL('../../packages/server/dist/index.js', import.meta.url));
const SHARED_DIST = fileURLToPath(new URL('../../packages/shared/dist/index.js', import.meta.url));

const SETTINGS = {
  provider: 'openai-compat',
  model: 'mock',
  temperature: 0.7,
  maxHistoryMessages: 40,
  worldBookBudgetTokens: 2000,
  scanDepth: 4,
};

type AnyRecord = Record<string, unknown>;

const created: string[] = [];
const sockets: Socket[] = [];
const apps: Array<{ close(): Promise<void> }> = [];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface AppLike {
  listen(opts: { port: number; host: string }): Promise<unknown>;
  close(): Promise<void>;
  server: { address(): { port: number } | null };
}

interface Harness {
  port: number;
  dataDir: string;
  roomId: string;
  sessionId: string;
  host: Socket;
  playerA: Socket;
  memberA: string;
  states: Map<Socket, AnyRecord[]>;
  errors: Map<Socket, AnyRecord[]>;
}

async function startServer(): Promise<{ port: number; dataDir: string; protocol: string }> {
  const serverModule = (await import(/* @vite-ignore */ pathToFileURL(SERVER_DIST).href)) as {
    createServer(opts: Record<string, unknown>): Promise<AppLike>;
  };
  const sharedModule = (await import(/* @vite-ignore */ pathToFileURL(SHARED_DIST).href)) as {
    PROTOCOL_VERSION: string;
  };
  const dataDir = await mkdtemp(path.join(tmpdir(), 'bv-stateflow-'));
  created.push(dataDir);

  const app = await serverModule.createServer({ dataDir, logger: false });
  apps.push(app);
  await app.listen({ port: 0, host: '127.0.0.1' });
  await sleep(150); // 等 Socket.IO 挂载
  return {
    port: app.server.address()?.port ?? 0,
    dataDir,
    protocol: sharedModule.PROTOCOL_VERSION,
  };
}

async function connect(port: number, protocol: string): Promise<Socket> {
  const socket = io(`http://127.0.0.1:${port}`, {
    auth: { protocol },
    transports: ['websocket'],
    reconnection: false,
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.on('connect', () => resolve());
    socket.on('connect_error', (err: Error) => reject(err));
  });
  return socket;
}

function emitAck(socket: Socket, event: string, payload: unknown): Promise<AnyRecord> {
  return new Promise((resolve) =>
    socket.emit(event, payload, (resp: unknown) => resolve(resp as AnyRecord)),
  );
}

async function waitUntil(cond: () => boolean, desc: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(25);
  }
  throw new Error(`等待超时：${desc}`);
}

/** 建一个「Host + 一名玩家在场、已开团」的房间；开团前以速建表声明玩家 PC */
async function setupRoom(): Promise<Harness> {
  const { port, dataDir, protocol } = await startServer();

  const host = await connect(port, protocol);
  const playerA = await connect(port, protocol);

  const states = new Map<Socket, AnyRecord[]>([
    [host, []],
    [playerA, []],
  ]);
  const errors = new Map<Socket, AnyRecord[]>([
    [host, []],
    [playerA, []],
  ]);
  for (const [socket, bucket] of states) {
    socket.on('state:broadcast', (payload: unknown) => bucket.push(payload as AnyRecord));
  }
  for (const [socket, bucket] of errors) {
    socket.on('error:app', (payload: unknown) => bucket.push(payload as AnyRecord));
  }

  const room = (await (
    await fetch(`http://127.0.0.1:${port}/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '状态板房' }),
    })
  ).json()) as { id: string; inviteCode: string; hostToken: string };

  const hostAck = await emitAck(host, 'room:join', {
    inviteCode: room.inviteCode,
    name: 'KP',
    hostToken: room.hostToken,
  });
  expect(hostAck['role']).toBe('host');
  const aAck = await emitAck(playerA, 'room:join', { inviteCode: room.inviteCode, name: 'A' });
  expect(aAck['ok']).toBe(true);
  const memberA = String(aAck['memberId']);

  // 开团前声明（T-M5-04 速建表路径，SDD §5.1）
  const declare = await fetch(`http://127.0.0.1:${port}/rooms/${room.id}/pcs/${memberA}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
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
        skills: { 侦查: 60 },
      },
    }),
  });
  expect(declare.status).toBe(201);

  const sessionAck = await emitAck(host, 'session:start', {
    moduleId: 'mod-state',
    settings: SETTINGS,
  });
  expect(sessionAck['ok']).toBe(true);
  await sleep(200); // 开团 notice 落地

  return {
    port,
    dataDir,
    roomId: room.id,
    sessionId: String((sessionAck['session'] as AnyRecord)['id']),
    host,
    playerA,
    memberA,
    states,
    errors,
  };
}

function stateBoards(h: Harness, socket: Socket): AnyRecord[] {
  return (h.states.get(socket) ?? []).map((payload) => payload['stateBoard'] as AnyRecord);
}

afterAll(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const app of apps.splice(0)) await app.close();
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('state:update 写路径（T-M5-06，FR-09）', () => {
  it('声明装配：初始板已含开团前声明的 PC（速建表 → 状态板初始 pcs）', async () => {
    const h = await setupRoom();
    h.host.emit('state:update', { patch: { facts: ['首次编辑'] }, expectedVersion: 0 });
    await waitUntil(
      () => stateBoards(h, h.host).some((b) => b['version'] === 1),
      'host 收到 version=1 广播',
    );
    const board = stateBoards(h, h.host).find((b) => b['version'] === 1);
    const pcs = board?.['pcs'] as Record<string, AnyRecord>;
    expect(pcs[h.memberA]).toBeDefined();
    expect((pcs[h.memberA]['sheet'] as AnyRecord)['playerName']).toBe('爱丽丝');
  });

  it('TC-FR-09-001/002：命中 → version+1 落盘并全员广播一致', async () => {
    const h = await setupRoom();
    h.host.emit('state:update', {
      patch: { scene: { name: '书房', time: '1925 年冬夜', publicDesc: '壁炉将熄。' } },
      expectedVersion: 0,
    });
    await waitUntil(
      () => stateBoards(h, h.playerA).some((b) => b['version'] === 1),
      'player 收到 version=1 广播',
    );
    for (const socket of [h.host, h.playerA]) {
      expect(stateBoards(h, socket).at(-1)).toMatchObject({
        version: 1,
        scene: { name: '书房' },
      });
    }
    // 落盘一致性：state.json 版本与广播一致
    const raw = JSON.parse(
      await readFile(
        path.join(h.dataDir, 'rooms', h.roomId, 'sessions', h.sessionId, 'state.json'),
        'utf8',
      ),
    ) as AnyRecord;
    expect(raw['version']).toBe(1);
  });

  it('TC-FR-09-001：expectedVersion 过期 → E-ST-01 拒绝 + 广播最新版', async () => {
    const h = await setupRoom();
    h.host.emit('state:update', { patch: { facts: ['第一笔'] }, expectedVersion: 0 });
    await waitUntil(() => stateBoards(h, h.host).some((b) => b['version'] === 1), '第一笔生效');

    h.host.emit('state:update', { patch: { facts: ['迟到的编辑'] }, expectedVersion: 0 });
    await waitUntil(
      () => (h.errors.get(h.host) ?? []).some((e) => e['code'] === 'E-ST-01'),
      'host 收到 E-ST-01',
    );
    // 冲突后广播最新版（version=1，不含迟到编辑）——发起者与全员对齐
    await waitUntil(
      () => stateBoards(h, h.host).filter((b) => b['version'] === 1).length >= 2,
      '冲突后广播最新版',
    );
    const latest = stateBoards(h, h.host)
      .filter((b) => b['version'] === 1)
      .at(-1);
    expect(latest?.['facts'] as string[]).toEqual(['第一笔']);
    expect((h.errors.get(h.host) ?? []).filter((e) => e['code'] === 'E-ST-01')).toHaveLength(1);
  });

  it('TC-FR-09-003：player 的 state:update 被拒（E-ROOM-01），不产生广播', async () => {
    const h = await setupRoom();
    h.playerA.emit('state:update', { patch: { facts: ['越权'] }, expectedVersion: 0 });
    await waitUntil(
      () => (h.errors.get(h.playerA) ?? []).some((e) => e['code'] === 'E-ROOM-01'),
      'player 收到拒绝',
    );
    expect(stateBoards(h, h.playerA)).toHaveLength(0);
  });
});
