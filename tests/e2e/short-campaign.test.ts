import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { io, type Socket } from 'socket.io-client';

/**
 * T-M5-11：完整短团 E2E（TC-FR-11-003，FR-01~10 串联；D-05 选型 Playwright——
 * 本剧本按 TDD §10「脚本化短团」口径走协议层回放（REST 管理面 + Socket.IO 网关，
 * 与 F-03 指令回归同一载体），浏览器级全流程走查归 T-M6-07。
 *
 * 剧本：建房 → 全员进房 → 声明 PC（速建表）→ 放置并装载模组 → 开团（initState +
 * 声明装配进初始板）→ 玩家 IC 触发 KP 开场（叙事 + 侦查检定：取值出自状态板 →
 * 服务端掷骰 → 回注续写）→ Host 状态变更（乐观锁）→ 生成快照（SnapshotMsg 入流）
 * → prompt 预览含快照行；全程 error:app 必须为空（0 阻断）。
 */

const SERVER_DIST = fileURLToPath(new URL('../../packages/server/dist', import.meta.url));

const { createServer } = (await import(pathToFileURL(path.join(SERVER_DIST, 'index.js')).href)) as {
  createServer(opts: Record<string, unknown>): Promise<AppLike>;
};
const { createDataLayout } = (await import(
  pathToFileURL(path.join(SERVER_DIST, 'adapters/storage/layout.js')).href
)) as { createDataLayout(root: string): DataLayout };
const { createMockLlm } = (await import(
  pathToFileURL(path.join(SERVER_DIST, 'adapters/llm/mock.js')).href
)) as { createMockLlm(options: { script?: MockScriptStep[] }): unknown };
const { PROTOCOL_VERSION } = (await import(
  pathToFileURL(path.join(SERVER_DIST, '../../shared/dist/index.js')).href
)) as { PROTOCOL_VERSION: string };

type AnyRecord = Record<string, unknown>;

interface AppLike {
  listen(opts: { port: number; host: string }): Promise<unknown>;
  close(): Promise<void>;
  server: { address(): { port: number } | null };
}
interface DataLayout {
  modulesDir: string;
  stateFile(roomId: string, sessionId: string): string;
}
interface MockScriptStep {
  delta?: string;
  directive?: { op: 'check'; target: string; skill: string; difficulty: string; label: string };
  stop?: boolean;
}

const created: string[] = [];
const sockets: Socket[] = [];
const closers: Array<() => Promise<void>> = [];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitUntil(cond: () => boolean, desc: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(25);
  }
  throw new Error(`等待超时：${desc}`);
}

async function connect(port: number): Promise<Socket> {
  const socket = io(`http://127.0.0.1:${port}`, {
    auth: { protocol: PROTOCOL_VERSION },
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

const SHEET = {
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
};

/** 模组三件套落盘：init-state 定义场景与事实（TC-FR-10-003 的剧本侧输入） */
async function writeModule(dataDir: string): Promise<void> {
  const dir = path.join(dataDir, 'modules', 'e2e-short');
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      id: 'e2e-short',
      name: '旧宅一夜',
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
        scenario: '旧宅一夜',
        first_mes: '',
        mes_example: '',
        extensions: { aidle: { rulebook: 'coc7' } },
      },
    }),
  );
  await writeFile(path.join(dir, 'worldbook.json'), JSON.stringify({ entries: [] }));
  await writeFile(
    path.join(dir, 'init-state.json'),
    JSON.stringify({
      scene: { name: '旧宅门厅', time: '1928 年秋夜', publicDesc: '吊灯摇晃，灰尘落满地板。' },
      facts: ['大门从内侧闩上了'],
      opening: '以门轴吱呀声开场。',
    }),
  );
}

/** Mock 剧本：KP 开场叙事 → 侦查检定指令 → 回注后续写（stop 分段，T-M3-06 口径） */
const SCRIPT: MockScriptStep[] = [
  { delta: '【开场】门轴吱呀作响，你们推门而入。\n' },
  {
    directive: {
      op: 'check',
      target: 'pc:爱丽丝',
      skill: '侦查',
      difficulty: 'normal',
      label: '打量门厅',
    },
  },
  { stop: true },
  { delta: '借着灯光，你看清墙上的抓痕一路延伸向楼梯。' },
  { stop: true },
];

afterAll(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const close of closers.splice(0)) await close();
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('完整短团 E2E（T-M5-11，TC-FR-11-003）', () => {
  it('建房→装模组→进房→声明→开场检定→状态变更→快照，全链路 0 阻断', async () => {
    // ---- 环境装配：REST 管理面 + 网关 + Mock 剧本（真文件存储） ----
    const dataDir = await mkdtemp(path.join(tmpdir(), 'bv-e2e-short-'));
    created.push(dataDir);
    const layout = createDataLayout(dataDir);
    await writeModule(dataDir);

    // 完整服务端（REST 管理面 + Socket.IO 网关 + 文件存储），LLM 注入剧本化 Mock（测试装配口）
    const mock = createMockLlm({ script: SCRIPT });
    const app = await createServer({ dataDir, logger: false, llm: mock as never });
    closers.push(async () => {
      await app.close();
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    await sleep(150); // 等 Socket.IO 挂载
    const port = (app.server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    // ---- 建房与进房（FR-01） ----
    const room = (await (
      await fetch(`${base}/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '短团房' }),
      })
    ).json()) as { id: string; inviteCode: string; hostToken: string };

    const errors: AnyRecord[] = [];
    const messages: AnyRecord[] = [];
    const states: AnyRecord[] = [];
    const previews: AnyRecord[] = [];

    const host = await connect(port);
    for (const [socket, bucket] of [[host, messages]] as Array<[Socket, AnyRecord[]]>) {
      socket.on('msg:broadcast', (payload: unknown) =>
        bucket.push((payload as AnyRecord).msg as AnyRecord),
      );
    }
    host.on('error:app', (payload: unknown) => errors.push(payload as AnyRecord));
    host.on('state:broadcast', (payload: unknown) =>
      states.push((payload as AnyRecord).stateBoard as AnyRecord),
    );
    host.on('kp:promptPreview', (payload: unknown) => previews.push(payload as AnyRecord));

    const hostAck = await emitAck(host, 'room:join', {
      inviteCode: room.inviteCode,
      name: 'KP',
      hostToken: room.hostToken,
    });
    expect(hostAck['ok']).toBe(true);
    expect(hostAck['role']).toBe('host');

    // ---- 装载模组（FR-10）：REST 校验通过 ----
    const loadRes = await fetch(`${base}/modules`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ moduleId: 'e2e-short' }),
    });
    expect(loadRes.status).toBe(201);

    // ---- 声明 PC（FR-08，速建表路径） ----
    const player = await connect(port);
    // player 的广播由 host 侧统一收集（双份收集会让计数断言提前通过）
    const playerAck = await emitAck(player, 'room:join', {
      inviteCode: room.inviteCode,
      name: '阿探',
    });
    expect(playerAck['ok']).toBe(true);
    const memberA = String(playerAck['memberId']);

    const declareRes = await fetch(`${base}/rooms/${room.id}/pcs/${memberA}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sheet: SHEET }),
    });
    expect(declareRes.status).toBe(201);

    // ---- 开团（FR-10/11）：initState + 声明装配进初始状态板（TC-FR-10-003） ----
    const sessionAck = await emitAck(host, 'session:start', {
      moduleId: 'e2e-short',
      settings: {
        provider: 'openai-compat',
        model: 'mock',
        temperature: 0.7,
        maxHistoryMessages: 40,
        worldBookBudgetTokens: 2000,
        scanDepth: 4,
        contextWindowTokens: 32768,
        outputReserveTokens: 2048,
      },
    });
    expect(sessionAck['ok']).toBe(true);
    const sessionId = String((sessionAck['session'] as AnyRecord)['id']);
    await sleep(200);

    const stateRes = await fetch(`${base}/rooms/${room.id}/state`);
    expect(stateRes.status).toBe(200);
    const { stateBoard: initialBoard } = (await stateRes.json()) as { stateBoard: AnyRecord };
    expect(initialBoard).toMatchObject({
      version: 0,
      scene: { name: '旧宅门厅', time: '1928 年秋夜' },
      facts: ['大门从内侧闩上了'],
    });
    const initialPcs = initialBoard['pcs'] as Record<string, AnyRecord>;
    expect(initialPcs[memberA]).toBeDefined();
    expect((initialPcs[memberA]['sheet'] as AnyRecord)['playerName']).toBe('爱丽丝');

    // ---- 开场与检定闭环（FR-02/03/05）：IC → KP 叙事 + 指令块 → 服务端掷骰 → 回注续写 ----
    player.emit('msg:send', { type: 'ic', content: '我们推开门，仔细打量门厅。' });
    await waitUntil(
      () => messages.filter((m) => m['type'] === 'narration').length >= 2,
      '两段叙事落盘',
    );
    const narrations = messages.filter((m) => m['type'] === 'narration');
    expect(String(narrations[0]?.['content'])).toContain('门轴吱呀');
    expect(String(narrations[1]?.['content'])).toContain('抓痕');

    const dice = messages.find((m) => m['type'] === 'dice');
    expect(dice).toBeDefined();
    // 检定取值出自状态板（T-M5-04）：服务端拼 1d100<=60，AI 全程不产数值
    expect((dice?.['roll'] as AnyRecord)['expr']).toBe('1d100<=60');
    expect(String((dice?.['roll'] as AnyRecord)['audit'] ?? '')).not.toBe('');

    // ---- 状态变更（FR-09）：Host 乐观锁编辑 → state:broadcast 全员一致 ----
    host.emit('state:update', {
      patch: { facts: ['楼梯上的抓痕是新鲜的'] },
      expectedVersion: 0,
    });
    await waitUntil(() => states.some((b) => b['version'] === 1), '状态板广播 v1');
    expect(states.some((b) => (b['facts'] as string[]).includes('楼梯上的抓痕是新鲜的'))).toBe(
      true,
    );

    // ---- 快照（FR-09）：SnapshotMsg 入流，prompt 常驻注入 ----
    host.emit('state:snapshot', {});
    await waitUntil(() => messages.some((m) => m['type'] === 'state_snapshot'), '快照消息入流');
    host.emit('kp:previewPrompt', {});
    await waitUntil(() => previews.length > 0, 'prompt 预览回包');
    const trace = (previews.at(-1) as AnyRecord)['pipeline'] as AnyRecord;
    const contents = (trace['messages'] as Array<{ content: string }>).map((m) => m.content);
    expect(contents.some((c) => c.includes('[快照]'))).toBe(true);
    expect(contents.some((c) => c.includes('【状态板 v1】'))).toBe(true);

    // ---- 落盘一致性：state.json 版本与广播一致（WAP） ----
    const { readFile } = await import('node:fs/promises');
    const persisted = JSON.parse(
      await readFile(layout.stateFile(room.id, sessionId), 'utf8'),
    ) as AnyRecord;
    expect(persisted['version']).toBe(1);

    // ---- 0 阻断（TC-FR-11-003）：全程无 error:app ----
    expect(errors).toEqual([]);
  });
});
