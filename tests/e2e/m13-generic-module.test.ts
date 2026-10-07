import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { io, type Socket } from 'socket.io-client';
import { afterAll, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@behindveil/shared';

/**
 * T-M13-03 / G-M13「generic 示例模组开箱即跑」的自动化验证（真团体验轮的机器侧前置）：
 * 1. 种子脚本把 examples/modules/greycape-generic/ 落进 data/modules/；
 * 2. generic KP 卡开团：session.rulebook='generic' + 配置快照落会话（FR-40 / ADR-3-08）；
 * 3. MockLlm 剧本触发 generic 判定（2d6+修正>=7 三档）、资源计数器（M12 集成）、伤害；
 *    玩家手骰走会话规则书；审计回放（含档表快照）零失配。
 *
 * 与 tests/ 其他文件同口径：从**构建产物**取模块，本文件需在 `pnpm build` 之后运行。
 */
const SERVER_DIST = fileURLToPath(new URL('../../packages/server/dist', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const execFileAsync = promisify(execFile);

const { createServer } = (await import(pathToFileURL(path.join(SERVER_DIST, 'index.js')).href)) as {
  createServer(opts: Record<string, unknown>): Promise<AppLike>;
};
const { loadModule } = (await import(
  pathToFileURL(path.join(SERVER_DIST, 'domain/module/library.js')).href
)) as {
  loadModule(
    layout: DataLayout,
    dirName: string,
  ): Promise<{
    ok: boolean;
    module?: { manifest: { rulebook: string; name: string } };
    message?: string;
  }>;
};
const { createDataLayout } = (await import(
  pathToFileURL(path.join(SERVER_DIST, 'adapters/storage/layout.js')).href
)) as { createDataLayout(root: string): DataLayout };
const { readStateBoard } = (await import(
  pathToFileURL(path.join(SERVER_DIST, 'domain/stateboard/board.js')).href
)) as {
  readStateBoard(
    layout: DataLayout,
    roomId: string,
    sessionId: string,
  ): Promise<{
    pcs: Record<
      string,
      {
        sheet: { hp: { current: number; max: number } };
        resources: Array<{ name: string; current: number }>;
      }
    >;
  }>;
};
const { replayAuditFile } = (await import(
  pathToFileURL(path.join(SERVER_DIST, 'tools/audit-replay.js')).href
)) as { replayAuditFile(file: string): Promise<{ total: number; mismatches: unknown[] }> };
const { createMockLlm } = (await import(
  pathToFileURL(path.join(SERVER_DIST, 'adapters/llm/mock.js')).href
)) as { createMockLlm(opts: { script: MockScriptStep[] }): MockLlmAdapter };

interface AppLike {
  listen(opts: { port: number; host: string }): Promise<unknown>;
  close(): Promise<void>;
  server: { address(): { port: number } | null };
}
interface DataLayout {
  modulesDir: string;
  auditDiceFile: string;
}
interface MockScriptStep {
  delta?: string;
  directive?: Record<string, unknown>;
  stop?: boolean;
}
interface MockLlmAdapter {
  id: string;
}
interface AnyRecord {
  [key: string]: unknown;
}

const settings = {
  provider: 'openai-compat',
  model: 'deepseek-chat',
  temperature: 0.7,
  maxHistoryMessages: 40,
  worldBookBudgetTokens: 2000,
  scanDepth: 4,
};

// AI 剧本：第一轮两条 generic 检定（带 dc），第二轮 resource（不掷骰）+ damage。
// MockLlm 的 directive 步骤不带前后换行——连续指令块之间必须补 delta；
// 轮次边界必须在 wrap-up delta 后补 stop，否则下一段会被卷进同轮续写（撞每轮 3 条上限）
const AI_SCRIPT: MockScriptStep[] = [
  { delta: '灯室的油路堵着，先通开它，再爬上灯室看看。\n' },
  {
    directive: {
      op: 'check',
      target: 'pc:爱丽丝',
      skill: '智力',
      dc: 7,
      label: '通开油路',
    },
  },
  { delta: '\n' },
  {
    directive: {
      op: 'check',
      target: 'pc:爱丽丝',
      skill: '力量',
      dc: 9,
      label: '夜爬旋梯',
    },
  },
  { stop: true },
  { delta: '灯芯烧得歪了些，光距短了一截。\n' },
  { stop: true }, // 轮次边界
  { delta: '雾里那声船笛又响了一次，灯油也下去了一格。\n' },
  {
    directive: { op: 'resource', target: 'pc:爱丽丝', name: '灯油', delta: -1, label: '点灯耗油' },
  },
  { delta: '\n' },
  { directive: { op: 'damage', target: 'pc:爱丽丝', expr: '1d6+1', label: '雾中之物的撞击' } },
  { stop: true },
  { delta: '灯室里重新只剩风声。' },
];

const sockets: Socket[] = [];
const closers: Array<() => Promise<void>> = [];

afterAll(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const close of closers.splice(0)) await close();
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitUntil(cond: () => boolean, desc: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(25);
  }
  throw new Error(`等待超时：${desc}`);
}

function connect(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(`http://127.0.0.1:${port}`, {
      auth: { protocol: PROTOCOL_VERSION },
      transports: ['websocket'],
      reconnection: false,
    });
    sockets.push(socket);
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (err: Error) => reject(err));
  });
}

function emitAck(socket: Socket, event: string, payload: unknown): Promise<AnyRecord> {
  return new Promise((resolve) =>
    socket.emit(event, payload, (resp: unknown) => resolve(resp as AnyRecord)),
  );
}

// 仅 session:start 有 ack；msg:send / dice:roll 均 fire-and-forget（以广播为准）
function emitFire(socket: Socket, event: string, payload: unknown): void {
  socket.emit(event, payload);
}

/** 轮询落盘状态板直至条件满足（引擎写板与广播异步竞逐的等待口径） */
async function pollBoard(
  layout: DataLayout,
  roomId: string,
  sessionId: string,
  cond: (board: { version: number }) => boolean,
  desc: string,
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const board = (await readStateBoard(layout, roomId, sessionId)) as unknown as {
      version: number;
    };
    if (cond(board)) return;
    if (Date.now() > deadline) throw new Error(`等待超时：${desc}`);
    await sleep(25);
  }
}

describe('示例模组「灰岬灯塔夜班」开箱即跑（T-M13-03 / G-M13）', () => {
  it('种子 → 装载 → generic 开团 → 三档判定/资源/伤害 → 手骰走会话规则书 → 审计回放零失配', async () => {
    // ---- 第 1 关：种子脚本 = 发布部署的真实装模组路径 ----
    const dataDir = await mkdtemp(path.join(tmpdir(), 'bv-m13-generic-'));
    await execFileAsync(
      'node',
      [path.join(REPO_ROOT, 'scripts/seed-example-module.mjs'), '--data-dir', dataDir],
      { cwd: REPO_ROOT },
    );
    const layout = createDataLayout(dataDir);

    // ---- 第 2 关：装载校验 + 完整服务端 ----
    const loaded = await loadModule(layout, 'greycape-generic');
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.module!.manifest.rulebook).toBe('generic');
      expect(loaded.module!.manifest.name).toBe('灰岬灯塔夜班');
    }

    const mock = createMockLlm({ script: AI_SCRIPT });
    const app = await createServer({ dataDir, logger: false, llm: mock as never });
    closers.push(async () => {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    await sleep(150);
    const port = (app.server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    const room = (await (
      await fetch(`${base}/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '灰岬房' }),
      })
    ).json()) as { id: string; inviteCode: string; hostToken: string };

    const host = await connect(port);
    const hostAck = await emitAck(host, 'room:join', {
      inviteCode: room.inviteCode,
      hostToken: room.hostToken,
      name: 'KP',
    });
    expect(hostAck.ok).toBe(true);

    const msgs: AnyRecord[] = [];
    host.on('msg:broadcast', (payload: unknown) =>
      msgs.push((payload as AnyRecord).msg as AnyRecord),
    );
    host.on('error:app', (payload: unknown) => msgs.push({ __error: payload as AnyRecord }));

    // ---- 第 3 关：generic 开团（KP 卡配置经装载编译，session:start 是 E-MOD-01 闸门） ----
    const sessionAck = await emitAck(host, 'session:start', {
      moduleId: 'greycape-generic',
      settings,
    });
    expect(sessionAck.ok).toBe(true);
    const sessionId = sessionAck.session?.id as string;
    // 会话自足（FR-40）：规则书标识 + 配置快照都落在会话记录里
    expect(sessionAck.session?.rulebook).toBe('generic');
    expect(sessionAck.session?.genericRule).toMatchObject({ dice: '2d6', op: '>=' });

    // 初始板：5e 卡（属性调整值即「灯芯规」的修正）+ Host 挂的灯油计数器
    const { saveStateBoard } = (await import(
      pathToFileURL(path.join(SERVER_DIST, 'domain/stateboard/board.js')).href
    )) as {
      saveStateBoard(l: DataLayout, r: string, s: string, b: unknown): Promise<void>;
    };
    await saveStateBoard(layout, room.id, sessionId, {
      version: 0,
      pcs: {
        alice: {
          sheet: {
            rulebook: 'dnd5e',
            playerName: '爱丽丝',
            occupation: '灯塔测绘员',
            abilities: { str: 14, dex: 12, con: 12, int: 16, wis: 10, cha: 8 },
            proficiencyBonus: 2,
            ac: 13,
            hp: { max: 17, current: 17 },
            proficientSkills: ['调查'],
            proficientSaves: ['int'],
          },
          conditions: [],
          resources: [{ name: '灯油', current: 3, max: 3 }],
        },
      },
      scene: { name: '', time: '', publicDesc: '' },
      facts: [],
      updatedAt: new Date().toISOString(),
    });

    const player = await connect(port);
    const playerAck = await emitAck(player, 'room:join', {
      inviteCode: room.inviteCode,
      name: '阿灯',
      wantRole: 'player',
    });
    expect(playerAck.ok).toBe(true);

    const rolls = (): Array<{
      expr: string;
      total: number;
      check?: {
        rulebook: string;
        kind: string;
        target: number;
        op: string;
        outcome: string;
        genericGrades?: Array<{ name: string; when: string }>;
      } | null;
    }> =>
      msgs
        .filter((m) => m.type === 'dice')
        .map((m) => (m as unknown as { roll: never }).roll as never);
    const resultCount = (): number =>
      msgs.filter((m) => m.type === 'system' && m.subtype === 'ai_directive_result').length;

    // ---- 机制组 A：generic 检定（骰型/方向/目标全来自配置与指令 dc） ----
    emitFire(player, 'msg:send', { type: 'ic', content: '我去通油路，然后爬上灯室。' });
    await waitUntil(() => resultCount() >= 2, '第一轮两条检定回注');

    // ---- 机制组 B：resource（不掷骰）+ damage（效果骰） ----
    emitFire(player, 'msg:send', { type: 'ic', content: '灯亮了。雾里有什么撞了过来！' });
    await waitUntil(() => resultCount() >= 4, '两轮共四条回注');

    const allRolls = rolls();
    const checks = allRolls.filter((r) => (r.check ?? null) !== null);
    expect(checks).toHaveLength(2); // 两条检定；resource 不掷骰、damage 无判定
    for (const check of checks) {
      expect(check.check!.rulebook).toBe('generic');
      expect(check.check!.kind).toBe('check'); // kinds[0] 缺省；档表快照随记录落流水
      expect(check.check!.genericGrades).toEqual([{ name: 'critical', when: 'total>=10' }]);
    }
    expect(checks[0]!.expr).toBe('2d6+3>=7'); // int 16 → +3
    expect(checks[0]!.check!.target).toBe(7);
    expect(checks[1]!.expr).toBe('2d6+2>=9'); // str 14 → +2
    expect(checks[1]!.check!.target).toBe(9);
    // 三档口径自洽：outcome 必落在档表语义内
    for (const check of checks) {
      expect(['critical', 'success', 'fail']).toContain(check.check!.outcome);
    }

    const effectRolls = allRolls.filter((r) => (r.check ?? null) === null);
    expect(effectRolls).toHaveLength(1); // damage
    expect(effectRolls[0]!.expr).toBe('1d6+1');

    // 资源与 HP 链以落盘 state.json 为准：灯油 3 → 2（resource 引擎写）、HP 扣伤害（damage 引擎写）
    await pollBoard(layout, room.id, sessionId, (b) => b.version >= 2, '两次引擎写板落盘');
    const board = await readStateBoard(layout, room.id, sessionId);
    expect(board.pcs.alice?.resources[0]?.current).toBe(2);
    const damageTotal = effectRolls[0]!.total;
    expect(board.pcs.alice?.sheet.hp.current).toBe(Math.max(0, 17 - damageTotal));

    // ---- 机制组 C：玩家手骰走会话规则书（generic 判定，defaultKind=check） ----
    emitFire(player, 'dice:roll', { expr: '2d6+1>=7', label: '辨认雾中灯号' });
    await waitUntil(() => rolls().length >= 4, '手骰入流');
    const manual = rolls().find((r) => r.expr === '2d6+1>=7');
    expect(manual).toBeDefined();
    expect(manual!.check!.rulebook).toBe('generic');
    expect(manual!.check!.kind).toBe('check');
    expect(manual!.check!.genericGrades).toEqual([{ name: 'critical', when: 'total>=10' }]);

    // ---- 审计回放：generic 判定带档表快照重算零失配 ----
    const report = await replayAuditFile(layout.auditDiceFile);
    expect(report.total).toBeGreaterThanOrEqual(4);
    expect(report.mismatches).toEqual([]);
  });
});
