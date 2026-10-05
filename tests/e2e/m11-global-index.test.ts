import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import { PROTOCOL_VERSION } from '@behindveil/shared';

/**
 * 跨房间索引接线（v3 T-M11-05，FR-34）：**证明网关真的在写索引**，而不是只有
 * 单元层自说自话。索引是「消息落盘同批追加」的副产品——单测覆盖不了这条接线，
 * 必须真连一次 socket：建房 → 进房 → 开团 → 发言 → 关服 → 读 `data/index/global.jsonl`。
 *
 * 两条边界一并钉住：
 * - 索引行携带 roomId/sessionId/seq（跨房间检索要能定位到「哪一团的哪一句」）；
 * - 暗骰也进索引（隐藏的是广播范围，不是凭据——与审计流水同一哲学），
 *   可见性过滤只属于消息投递通道（GET /rooms/:id/messages），两套口径不混用。
 */

const { createServer } = (await import('../../packages/server/src/index.js')) as unknown as {
  createServer: (opts: Record<string, unknown>) => Promise<{
    listen(opts: { port: number; host: string }): Promise<unknown>;
    close(): Promise<void>;
    server: { address(): { port: number } | null };
  }>;
};
const { createDataLayout } =
  (await import('../../packages/server/src/adapters/storage/layout.js')) as unknown as {
    createDataLayout: (root: string) => { globalIndexFile: string };
  };

type AnyRecord = Record<string, unknown>;

const created: string[] = [];
const sockets: Socket[] = [];
const closers: Array<() => Promise<void>> = [];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

/** 最小可开团模组（与 short-campaign 同形态，独立夹具避免互相牵连） */
async function writeModule(dataDir: string): Promise<void> {
  const dir = path.join(dataDir, 'modules', 'm11-index');
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      id: 'm11-index',
      name: '索引测试团',
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
        scenario: '雾中码头',
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
      scene: { name: '雾中码头', time: '1928 年秋夜', publicDesc: '雾号在远处响。' },
      facts: ['潮水正在上涨'],
      opening: '以雾号声开场。',
    }),
  );
}

async function readIndex(dataDir: string): Promise<AnyRecord[]> {
  const layout = createDataLayout(dataDir);
  const raw = await readFile(layout.globalIndexFile, 'utf8').catch(() => '');
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as AnyRecord);
}

/**
 * 临时目录清理带超时竞速：沙箱的文件删除守卫会**挂起** rm（不是报错，是卡住），
 * 直接 await 会让 afterAll 超时、把整文件判成 FAIL——而断言其实全过了。
 * 清理失败只留一点临时目录，比把绿测试判红划算得多。
 */
async function rmQuietly(dir: string): Promise<void> {
  await Promise.race([
    rm(dir, { recursive: true, force: true }).catch(() => undefined),
    sleep(2_000),
  ]);
}

afterAll(async () => {
  for (const socket of sockets.splice(0)) socket.disconnect();
  await Promise.all(closers.splice(0).map((close) => close()));
  for (const dir of created.splice(0)) await rmQuietly(dir);
});

describe('全局索引接线（FR-34）', () => {
  it('发言与掷骰落盘同批追加索引行，且带房间/会话/seq 定位信息', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'bv-m11-index-'));
    created.push(dataDir);
    await writeModule(dataDir);

    const app = await createServer({ dataDir, logger: false });
    // 关服也走超时竞速：Socket.IO 的 close 在某些时序下会迟迟不 resolve，
    // 而索引读取不需要关服（追加是同步 fsync），别让它卡死整条用例
    closers.push(async () => {
      await Promise.race([app.close().catch(() => undefined), sleep(2_000)]);
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    await sleep(150);
    const port = (app.server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    const room = (await (
      await fetch(`${base}/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '索引房' }),
      })
    ).json()) as { id: string; inviteCode: string; hostToken: string };

    const loadRes = await fetch(`${base}/modules`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ moduleId: 'm11-index' }),
    });
    expect(loadRes.status).toBe(201);

    const host = await connect(port);
    const joinAck = await emitAck(host, 'room:join', {
      inviteCode: room.inviteCode,
      name: 'KP',
      hostToken: room.hostToken,
    });
    expect(joinAck['ok']).toBe(true);

    const startAck = await emitAck(host, 'session:start', {
      moduleId: 'm11-index',
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
    expect(startAck['ok'], JSON.stringify(startAck)).toBe(true);
    // ack 回的是完整 session 对象（不是扁平的 sessionId 字段）
    const sessionId = String((startAck['session'] as AnyRecord)['id']);

    const MARKER = '我在雾里看见了灯塔的影子';
    host.emit('msg:send', { type: 'ic', content: MARKER });
    host.emit('dice:roll', { expr: '1d100', hidden: true });

    await sleep(400); // 主链路是同步落盘，这里只给广播与索引追加留余量

    const rows = await readIndex(dataDir);
    const icRow = rows.find((row) => row['type'] === 'ic' && row['content'] === MARKER);
    expect(icRow, `索引应含发言行，现有 ${rows.length} 行`).toBeDefined();
    expect(icRow!['roomId']).toBe(room.id);
    expect(icRow!['sessionId']).toBe(sessionId);
    expect(typeof icRow!['seq']).toBe('number');

    // 暗骰同样入索引（Host 视角完整版），可见性过滤不在这一层
    const diceRow = rows.find((row) => row['type'] === 'dice');
    expect(diceRow).toBeDefined();
    expect(diceRow!['hidden']).toBe(true);
    expect(String(diceRow!['content'])).toMatch(/^1d100 = \d+$/);
  });

  it('索引行单行 JSON：并发追加后逐行可解析（append 语义未破）', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'bv-m11-integrity-'));
    created.push(dataDir);
    const layout = createDataLayout(dataDir);

    const { GlobalIndex, indexEntryOf } =
      (await import('../../packages/server/src/observability/global-index.js')) as unknown as {
        GlobalIndex: new (file: string) => { append(entry: unknown): Promise<void> };
        indexEntryOf: (roomId: string, sessionId: string, message: unknown) => unknown;
      };
    const index = new GlobalIndex(layout.globalIndexFile);
    for (let i = 1; i <= 50; i += 1) {
      await index.append(
        indexEntryOf('r_1', 'ses_1', {
          seq: i,
          ts: '2026-10-04T00:00:00.000Z',
          sessionId: 'ses_1',
          type: 'ic',
          senderId: 'mem_1',
          content: `第 ${i} 条`,
        }),
      );
    }

    const raw = await readFile(layout.globalIndexFile, 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(50);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
