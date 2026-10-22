import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { io, type Socket } from 'socket.io-client';

/**
 * room:sync 房间状态推送（2026-10-07 GUI 真人调试修复）的集成验证：
 * 成员进离/开团此前只以 system 消息入流，已连接客户端的成员栏与「尚未开团」态
 * 不随之刷新（后进成员不可见、玩家端开团后输入仍禁用）。本套件走真实服务端断言：
 *   - 后进成员触发 room:sync，先在线者的成员栏数据随推送更新（P1-A）；
 *   - session:start 触发 room:sync，全员拿到 activeSessionId（P0-B）；
 *   - 成员离线触发 room:sync，离线者从其余客户端的成员栏消失。
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

async function startServer(): Promise<{ port: number; dataDir: string; protocol: string }> {
  const serverModule = (await import(/* @vite-ignore */ pathToFileURL(SERVER_DIST).href)) as {
    createServer(opts: Record<string, unknown>): Promise<AppLike>;
  };
  const sharedModule = (await import(/* @vite-ignore */ pathToFileURL(SHARED_DIST).href)) as {
    PROTOCOL_VERSION: string;
  };
  const dataDir = await mkdtemp(path.join(tmpdir(), 'bv-roomsync-'));
  created.push(dataDir);
  const app = await serverModule.createServer({ dataDir, logger: false });
  apps.push(app);
  await app.listen({ port: 0, host: '127.0.0.1' });
  await sleep(150);
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

interface SyncPayload {
  members: Array<{ id: string; name: string; role: string }>;
  activeSessionId: string | null;
}

function collectSyncs(socket: Socket): SyncPayload[] {
  const bucket: SyncPayload[] = [];
  socket.on('room:sync', (payload: unknown) => bucket.push(payload as SyncPayload));
  return bucket;
}

async function placeModule(dataDir: string, moduleId: string): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const dir = path.join(dataDir, 'modules', moduleId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      id: moduleId,
      name: moduleId,
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

afterAll(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const app of apps.splice(0)) await app.close();
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('room:sync 房间状态推送（2026-10-07 修复）', () => {
  it('后进成员 / 开团 / 离线三个变更点，先在线客户端均收到推送并对齐', async () => {
    const { port, dataDir, protocol } = await startServer();
    const host = await connect(port, protocol);
    const hostSyncs = collectSyncs(host);

    // ---- P1-A：Host 先进房，玩家后进——Host 收到 room:sync 且名册含两人 ----
    const room = (await (
      await fetch(`http://127.0.0.1:${port}/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '推送房' }),
      })
    ).json()) as { id: string; inviteCode: string; hostToken: string };
    const hostAck = await emitAck(host, 'room:join', {
      inviteCode: room.inviteCode,
      name: 'KP',
      hostToken: room.hostToken,
    });
    expect(hostAck['ok']).toBe(true);

    const player = await connect(port, protocol);
    const playerSyncs = collectSyncs(player);
    const playerAck = await emitAck(player, 'room:join', {
      inviteCode: room.inviteCode,
      name: '阿灯',
    });
    expect(playerAck['ok']).toBe(true);

    await waitUntil(() => hostSyncs.some((s) => s.members.length === 2), 'Host 收到两人名册推送');
    const joinSync = hostSyncs.find((s) => s.members.length === 2)!;
    expect(joinSync.members.map((m) => m.name).sort()).toEqual(['KP', '阿灯']);
    expect(joinSync.activeSessionId).toBeNull();

    // ---- P0-B：开团后全员（含先在线的 Host）收到 activeSessionId ----
    await placeModule(dataDir, 'mod-sync');
    const sessionAck = await emitAck(host, 'session:start', {
      moduleId: 'mod-sync',
      settings: SETTINGS,
    });
    expect(sessionAck['ok']).toBe(true);
    const sessionId = String((sessionAck['session'] as AnyRecord)['id']);

    await waitUntil(
      () => hostSyncs.some((s) => s.activeSessionId === sessionId),
      'Host 收到开团推送',
    );
    await waitUntil(
      () => playerSyncs.some((s) => s.activeSessionId === sessionId),
      '玩家收到开团推送',
    );
    // 推送上的名册与开团时刻一致
    const startSync = playerSyncs.find((s) => s.activeSessionId === sessionId)!;
    expect(startSync.members).toHaveLength(2);

    // ---- 离线：玩家断开后，Host 的成员栏推送只剩 Host ----
    player.disconnect();
    await waitUntil(() => hostSyncs.some((s) => s.members.length === 1), 'Host 收到离线推送');
    const leaveSync = hostSyncs.find((s) => s.members.length === 1)!;
    expect(leaveSync.members[0]?.name).toBe('KP');
  });
});
