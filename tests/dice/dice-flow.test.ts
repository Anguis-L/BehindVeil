import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { io, type Socket } from 'socket.io-client';

/**
 * T-M4-02/03 端到端：玩家骰与暗骰可见性（FR-06 / FR-14，决议 D-10）+ E-DICE-01。
 *
 * 走真实服务端（Fastify + Socket.IO 网关 + 文件存储），三客户端同房：
 *   Host（KP）· playerA（掷骰者）· playerB（旁人，不该看到暗骰）
 * 断言：明骰全房可见且带审计号；暗骰只投 Host 与掷骰者本人；
 * 非法骰式只回请求者、不入消息流也不入审计；断线补发不泄露暗骰。
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
  protocol: string;
  dataDir: string;
  inviteCode: string;
  host: Socket;
  playerA: Socket;
  playerB: Socket;
  memberA: string;
  seen: Map<Socket, AnyRecord[]>;
  errors: Map<Socket, AnyRecord[]>;
}

async function startServer(): Promise<{ port: number; dataDir: string; protocol: string }> {
  const serverModule = (await import(/* @vite-ignore */ pathToFileURL(SERVER_DIST).href)) as {
    createServer(opts: Record<string, unknown>): Promise<AppLike>;
  };
  const sharedModule = (await import(/* @vite-ignore */ pathToFileURL(SHARED_DIST).href)) as {
    PROTOCOL_VERSION: string;
  };
  const dataDir = await mkdtemp(path.join(tmpdir(), 'bv-dice-'));
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

/** 建一个「Host + 两名玩家在场、已开团」的房间 */
async function setupRoom(): Promise<Harness> {
  const { port, dataDir, protocol } = await startServer();

  const host = await connect(port, protocol);
  const playerA = await connect(port, protocol);
  const playerB = await connect(port, protocol);

  const seen = new Map<Socket, AnyRecord[]>([
    [host, []],
    [playerA, []],
    [playerB, []],
  ]);
  const errors = new Map<Socket, AnyRecord[]>([
    [host, []],
    [playerA, []],
    [playerB, []],
  ]);
  for (const [socket, bucket] of seen) {
    socket.on('msg:broadcast', (payload: unknown) => bucket.push(payload as AnyRecord));
  }
  for (const [socket, bucket] of errors) {
    socket.on('error:app', (payload: unknown) => bucket.push(payload as AnyRecord));
  }

  const room = (await (
    await fetch(`http://127.0.0.1:${port}/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '骰子房' }),
    })
  ).json()) as { inviteCode: string; hostToken: string };

  const hostAck = await emitAck(host, 'room:join', {
    inviteCode: room.inviteCode,
    name: 'KP',
    hostToken: room.hostToken,
  });
  expect(hostAck['role']).toBe('host');

  const aAck = await emitAck(playerA, 'room:join', { inviteCode: room.inviteCode, name: 'A' });
  const bAck = await emitAck(playerB, 'room:join', { inviteCode: room.inviteCode, name: 'B' });
  expect(aAck['ok']).toBe(true);
  expect(bAck['ok']).toBe(true);

  const sessionAck = await emitAck(host, 'session:start', {
    moduleId: 'mod-dice',
    settings: SETTINGS,
  });
  expect(sessionAck['ok']).toBe(true);
  await sleep(200); // 开团 notice 落地

  return {
    port,
    protocol,
    dataDir,
    inviteCode: room.inviteCode,
    host,
    playerA,
    playerB,
    memberA: String(aAck['memberId']),
    seen,
    errors,
  };
}

function diceMessages(h: Harness, socket: Socket): AnyRecord[] {
  return (h.seen.get(socket) ?? [])
    .map((payload) => payload['msg'] as AnyRecord)
    .filter((msg) => msg?.['type'] === 'dice');
}

async function waitUntil(cond: () => boolean, desc: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(25);
  }
  throw new Error(`等待超时：${desc}`);
}

afterAll(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const app of apps.splice(0)) await app.close();
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('玩家骰 dice:roll（T-M4-02，FR-06）', () => {
  it('明骰全房可见，带审计流水号与原始骰值', async () => {
    const h = await setupRoom();

    h.playerA.emit('dice:roll', { expr: '2d6+3<=8' });
    await waitUntil(
      () =>
        diceMessages(h, h.host).length === 1 &&
        diceMessages(h, h.playerA).length === 1 &&
        diceMessages(h, h.playerB).length === 1,
      '三方都收到明骰',
    );

    const msg = diceMessages(h, h.playerA)[0] as AnyRecord;
    const roll = msg['roll'] as AnyRecord;
    expect(msg['hidden']).toBe(false);
    expect(msg['senderId']).toBe(h.memberA);
    expect(roll['expr']).toBe('2d6+3<=8');
    expect(roll['total']).toBeGreaterThanOrEqual(5);
    expect(roll['total']).toBeLessThanOrEqual(15);
    expect((roll['rolls'] as number[][]).flat()).toHaveLength(2);
    expect((roll['audit'] as AnyRecord)['seq'] as string).toMatch(/^\d{6}$/);

    // 同一颗骰子，三方看到的审计号必须一致（凭据唯一）
    const seqOf = (socket: Socket): unknown =>
      ((diceMessages(h, socket)[0] as AnyRecord)['roll'] as AnyRecord)['audit'];
    expect(seqOf(h.host)).toEqual(seqOf(h.playerB));
    expect(seqOf(h.playerA)).toEqual(seqOf(h.playerB));
  });

  it('暗骰只投 Host 与掷骰者本人，旁人收不到（D-10）', async () => {
    const h = await setupRoom();

    h.playerA.emit('dice:roll', { expr: '1d100', hidden: true });
    await waitUntil(
      () => diceMessages(h, h.playerA).length === 1 && diceMessages(h, h.host).length === 1,
      'Host 与掷骰者收到暗骰',
    );

    await sleep(400); // 给旁人留出「本该收到」的窗口
    expect(diceMessages(h, h.playerB)).toHaveLength(0);

    const mine = diceMessages(h, h.playerA)[0] as AnyRecord;
    expect(mine['hidden']).toBe(true);
    expect(((mine['roll'] as AnyRecord)['audit'] as AnyRecord)['seq'] as string).toMatch(/^\d{6}$/);
  });

  it('observer 不能掷骰', async () => {
    const h = await setupRoom();
    const observer = await connect(h.port, h.protocol);
    const errors: AnyRecord[] = [];
    observer.on('error:app', (payload: unknown) => errors.push(payload as AnyRecord));

    const ack = await emitAck(observer, 'room:join', {
      inviteCode: h.inviteCode,
      name: '看客',
      wantRole: 'observer',
    });
    expect(ack['role']).toBe('observer');

    observer.emit('dice:roll', { expr: '1d100' });
    await waitUntil(() => errors.length > 0, 'observer 收到拒绝');

    expect(errors[0]?.['code']).toBe('E-ROOM-01');
  });
});

describe('非法骰式（T-M4-03，E-DICE-01）', () => {
  it('只回请求者行内提示，不广播、不入审计', async () => {
    const h = await setupRoom();

    h.playerA.emit('dice:roll', { expr: 'abc' });
    await waitUntil(() => (h.errors.get(h.playerA) ?? []).length > 0, 'playerA 收到 E-DICE-01');

    const err = (h.errors.get(h.playerA) ?? [])[0] as AnyRecord;
    expect(err['code']).toBe('E-DICE-01');
    expect(String(err['message'])).toContain('骰式语法'); // 附帮助文本，行内即可纠正

    await sleep(300);
    expect(diceMessages(h, h.playerA)).toHaveLength(0);
    expect(diceMessages(h, h.playerB)).toHaveLength(0);
    expect(diceMessages(h, h.host)).toHaveLength(0);

    // 压根没掷出骰子 → 审计流水不该出现
    await expect(
      readFile(path.join(h.dataDir, 'logs', 'audit-dice.jsonl'), 'utf8'),
    ).rejects.toThrow();
  });
});

describe('审计留痕（T-M4-01，NFR-04）', () => {
  it('每颗骰子（含暗骰）都在流水里留痕，号序递增', async () => {
    const h = await setupRoom();

    h.playerA.emit('dice:roll', { expr: '1d100' });
    await waitUntil(() => diceMessages(h, h.playerA).length === 1, '明骰落地');
    h.playerA.emit('dice:roll', { expr: '1d100', hidden: true });
    await waitUntil(() => diceMessages(h, h.playerA).length === 2, '暗骰落地');
    await sleep(200);

    const raw = await readFile(path.join(h.dataDir, 'logs', 'audit-dice.jsonl'), 'utf8');
    const entries = raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AnyRecord);

    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e['seq'])).toEqual(['000001', '000002']);
    expect(entries.map((e) => e['hidden'])).toEqual([false, true]); // 隐藏的是广播范围，不是凭据
    expect(entries[0]?.['actor']).toBe(h.memberA);
  });
});

describe('断线补发不泄露暗骰（T-M4-02 修正）', () => {
  it('旁人谎报 lastSeq=0 重连，补发里没有他人暗骰', async () => {
    const h = await setupRoom();

    h.playerA.emit('dice:roll', { expr: '1d100', hidden: true });
    await waitUntil(() => diceMessages(h, h.playerA).length === 1, '暗骰落地');

    const fresh = await connect(h.port, h.protocol);
    const replayed: AnyRecord[] = [];
    fresh.on('msg:broadcast', (payload: unknown) => replayed.push(payload as AnyRecord));
    const ack = await emitAck(fresh, 'room:join', {
      inviteCode: h.inviteCode,
      name: '旁人2',
      lastSeq: 0,
    });
    expect(ack['ok']).toBe(true);
    await sleep(400);

    expect(replayed.length).toBeGreaterThan(0); // 确实补发了（否则断言无意义）
    expect(replayed.filter((p) => (p['msg'] as AnyRecord)?.['type'] === 'dice')).toHaveLength(0);
  });

  it('掷骰者本人重连可补回自己的暗骰', async () => {
    const h = await setupRoom();

    h.playerA.emit('dice:roll', { expr: '1d100', hidden: true });
    await waitUntil(() => diceMessages(h, h.playerA).length === 1, '暗骰落地');

    const again = await connect(h.port, h.protocol);
    const replayed: AnyRecord[] = [];
    again.on('msg:broadcast', (payload: unknown) => replayed.push(payload as AnyRecord));
    await emitAck(again, 'room:join', {
      inviteCode: h.inviteCode,
      name: 'A',
      memberId: h.memberA,
      lastSeq: 0,
    });
    await sleep(400);

    const dice = replayed.filter((p) => (p['msg'] as AnyRecord)?.['type'] === 'dice');
    expect(dice).toHaveLength(1);
    expect(((dice[0] as AnyRecord)['msg'] as AnyRecord)['hidden']).toBe(true);
  });
});
