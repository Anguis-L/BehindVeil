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
 * T-M9-01 / G-M9「示例模组开箱即跑」的自动化验证（真团 ≥2h 手测的机器侧前置）：
 * 1. 种子脚本把 examples/modules/ 落进 data/modules/（发布包部署的真实路径）；
 * 2. REST 装载模组 + 新房开团（内容即 examples/ 发布内容，零人工改写）；
 * 3. MockLlm 剧本触发六类机制：属性检定 / 豁免 / 攻击 / 伤害 / 治疗，
 *    玩家手骰触发优劣势（adv/dis 展开），骰子卡、HP 变更、审计回放全链路断言。
 *
 * 与 tests/ 其他文件同口径：tests/ 不在 pnpm workspace 内，从**构建产物**取模块，
 * 本文件需在 `pnpm build` 之后运行（根 `pnpm test` 已包含该顺序）。
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
    reason?: string;
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
    pcs: Record<string, { sheet: { hp: { current: number; max: number } } }>;
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
  stateFile(roomId: string, sessionId: string): string;
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

// AI 剧本：第一轮 3 次检定（恰好触达每轮上限），第二轮 damage + heal。
// MockLlm 的 directive 步骤不带前后换行（栅栏行由相邻 delta 供给）——连续指令块之间必须补 delta
const AI_SCRIPT: MockScriptStep[] = [
  { delta: '横梁堵门，众人合力。\n' },
  {
    directive: {
      op: 'check',
      target: 'pc:爱丽丝',
      skill: '力量',
      difficulty: 'hard',
      label: '挪开横梁',
    },
  },
  { delta: '\n' },
  {
    directive: {
      op: 'check',
      target: 'pc:爱丽丝',
      skill: '体质',
      kind: 'save',
      label: '烈酒的考验',
    },
  },
  { delta: '\n' },
  {
    directive: {
      op: 'check',
      target: 'pc:爱丽丝',
      skill: '力量',
      kind: 'attack',
      dc: 13,
      label: '劈向夜嚎兽',
    },
  },
  { stop: true },
  { delta: '检定完毕，夜幕更深了。' },
  { stop: true }, // 轮次边界：Mock 只在 stop 处断开请求，否则下一段 delta 会混进本轮收尾
  { delta: '夜嚎兽扑进院子，又狼狈退走。\n' },
  { directive: { op: 'damage', target: 'pc:爱丽丝', expr: '2d6+2', label: '夜嚎兽的咬击' } },
  { delta: '\n' },
  { directive: { op: 'heal', target: 'pc:爱丽丝', expr: '2d4+2', label: '贺先生的药膏' } },
  { stop: true },
  { delta: '大堂里重新安静下来。' },
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

describe('示例模组「雾桥驿站」开箱即跑（T-M9-01 / G-M9）', () => {
  it('种子 → 装载 → 建房开团 → 六类机制触发 → HP 落盘 → 审计回放零失配', async () => {
    // ---- 第 1 关：种子脚本 = 发布部署的真实装模组路径 ----
    const dataDir = await mkdtemp(path.join(tmpdir(), 'bv-m9-example-'));
    await execFileAsync(
      'node',
      [path.join(REPO_ROOT, 'scripts/seed-example-module.mjs'), '--data-dir', dataDir],
      { cwd: REPO_ROOT },
    );
    const layout = createDataLayout(dataDir);

    // ---- 第 2 关：装载校验 + 完整服务端（REST 装载模组，与部署操作一致） ----
    const loaded = await loadModule(layout, 'fogbridge-5e');
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.module!.manifest.rulebook).toBe('dnd5e');
      expect(loaded.module!.manifest.name).toBe('雾桥驿站');
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

    // 建房（REST，部署口径）→ Host 进房
    const room = (await (
      await fetch(`${base}/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '雾桥房' }),
      })
    ).json()) as { id: string; inviteCode: string; hostToken: string };

    const host = await connect(port);
    const hostAck = await emitAck(host, 'room:join', {
      inviteCode: room.inviteCode,
      hostToken: room.hostToken,
      name: 'KP',
    });
    expect(hostAck.ok).toBe(true);
    expect(hostAck.role).toBe('host');

    const msgs: AnyRecord[] = [];
    host.on('msg:broadcast', (payload: unknown) =>
      msgs.push((payload as AnyRecord).msg as AnyRecord),
    );
    host.on('error:app', (payload: unknown) => msgs.push({ __error: payload as AnyRecord }));
    host.on('state:broadcast', (payload: unknown) => {
      const b = (
        payload as {
          stateBoard: { version: number; pcs: Record<string, { sheet: { hp: unknown } }> };
        }
      ).stateBoard;
      console.warn(
        '[m9 调试] state:broadcast v',
        b.version,
        'hp',
        JSON.stringify(b.pcs.alice?.sheet.hp),
      );
    });

    // ---- 第 3 关：开团（gateway 校验模组，E-MOD-01 闸门在 session:start） ----
    const sessionAck = await emitAck(host, 'session:start', { moduleId: 'fogbridge-5e', settings });
    expect(sessionAck.ok).toBe(true);
    const sessionId = sessionAck.session?.id as string;

    // 初始板：5e 卡（速建表口径，Host 录入即得的等价物）
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
            occupation: '战士',
            abilities: { str: 16, dex: 14, con: 14, int: 10, wis: 12, cha: 8 },
            proficiencyBonus: 2,
            ac: 15,
            hp: { max: 22, current: 22 },
            proficientSkills: ['运动'],
            proficientSaves: ['str', 'con'],
          },
          conditions: [],
          resources: [],
        },
      },
      scene: { name: '', time: '', publicDesc: '' },
      facts: [],
      updatedAt: new Date().toISOString(),
    });

    const player = await connect(port);
    const playerAck = await emitAck(player, 'room:join', {
      inviteCode: room.inviteCode,
      name: '阿探',
      wantRole: 'player',
    });
    expect(playerAck.ok).toBe(true);

    const diceOf = (): Array<{
      expr: string;
      total: number;
      check?: { kind: string; target: number; op: string } | null;
    }> =>
      msgs
        .filter((m) => m.type === 'dice')
        .map(
          (m) =>
            (
              m as unknown as {
                roll: {
                  expr: string;
                  total: number;
                  check?: { kind: string; target: number; op: string } | null;
                };
              }
            ).roll,
        );
    const resultCount = (): number =>
      msgs.filter((m) => m.type === 'system' && m.subtype === 'ai_directive_result').length;

    // ---- 机制组 A：属性检定 + 豁免 + 攻击（3 条指令恰好触达每轮上限） ----
    emitFire(player, 'msg:send', {
      type: 'ic',
      content: '我们合力清障，先喝口烈酒压惊，兽来了就劈！',
    });
    await waitUntil(() => resultCount() >= 3, '第一轮 3 条回注');

    // ---- 机制组 B：damage + heal ----
    emitFire(player, 'msg:send', { type: 'ic', content: '兽被劈退，我们处理伤口。' });
    await waitUntil(() => resultCount() >= 5, '两轮共 5 条回注');

    const rolls = diceOf();
    const kinds = rolls.map((r) => r.check?.kind);
    expect(kinds).toContain('ability');
    expect(kinds).toContain('save');
    expect(kinds).toContain('attack');
    const attack = rolls.find((r) => r.check?.kind === 'attack')!;
    expect(attack.check!.target).toBe(13);
    expect(attack.check!.op).toBe('>=');

    const effectRolls = rolls.filter((r) => (r.check ?? null) === null);
    expect(effectRolls).toHaveLength(2); // damage + heal，效果骰无判定
    const [damage, heal] = effectRolls;
    expect(damage!.expr).toBe('2d6+2');
    expect(heal!.expr).toBe('2d4+2');

    // HP 链：22 → 22−damage（clamp 0）→ +heal（clamp max）；权威以落盘 state.json 为准。
    // 引擎写板（applyEnginePatch）与回注广播异步竞逐：等两次引擎写都落盘（version 0 → 2）再断言。
    const afterDamage = Math.max(0, 22 - damage!.total);
    const expectedHp = Math.min(22, afterDamage + heal!.total);
    await pollBoard(
      layout,
      room.id,
      sessionId,
      (b) => (b.version as number) >= 2,
      '两次引擎写板落盘',
    );
    const board = await readStateBoard(layout, room.id, sessionId);
    const hpNow = board.pcs.alice?.sheet.hp.current as number;
    console.warn(
      '[m9 调试] damage',
      damage!.total,
      'heal',
      heal!.total,
      'board',
      JSON.stringify(board),
    );
    expect(hpNow).toBe(expectedHp);
    expect(hpNow).toBeLessThanOrEqual(22);
    expect(hpNow).toBeGreaterThanOrEqual(0);

    // ---- 机制组 C：优劣势（玩家手骰）——adv 展开 2d20kh1、dis 展开 2d20kl1 ----
    emitFire(player, 'dice:roll', { expr: '1d20+3>=13 adv', label: '高台射击' });
    emitFire(player, 'dice:roll', { expr: '1d20+2>=12 dis', label: '雾中潜行' });
    await waitUntil(() => diceOf().length >= 7, 'adv/dis 两颗骰入流');
    const advDice = diceOf().find((r) => r.expr.startsWith('2d20kh1'));
    const disDice = diceOf().find((r) => r.expr.startsWith('2d20kl1'));
    expect(advDice).toBeDefined();
    expect(disDice).toBeDefined();

    // ---- 审计回放：全部骰（含 adv/dis 展开后的骰式）重算零失配 ----
    const report = await replayAuditFile(layout.auditDiceFile);
    expect(report.total).toBeGreaterThanOrEqual(7);
    expect(report.mismatches).toEqual([]);
  });
});
