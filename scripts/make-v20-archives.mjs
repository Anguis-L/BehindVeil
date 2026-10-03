#!/usr/bin/env node
/**
 * v2.0 形态真实存档生成器（G-M10 门禁：aidle-migrate 干跑 ≥2 份真实存档）。
 *
 * 用 dist 服务端各跑一段完整团流程（建房 → 装模组 → 进房 → 声明 PC → 开团 →
 * IC/AI 回合（含检定指令闭环）→ 玩家掷骰/暗骰 → 状态编辑 → 快照），产出
 * COC7 团与 5e 团（复用 examples 的雾桥驿站模组）两份真实存档，然后把
 * schemaVersion 信封剥掉、members.json 退回裸数组——即 v2.0.0 封版时代的
 * 落盘形态，供 `aidle-migrate` 干跑与自检。M12 迁移门禁复用同一生成器。
 *
 * 用法：node scripts/make-v20-archives.mjs <输出根目录>（默认 data/gate）
 * 产物：<输出根>/<coc7-team|dnd5e-team>/data/
 */

import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { io } from 'socket.io-client';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const outRoot = path.resolve(process.argv[2] ?? path.join(repoRoot, 'data', 'gate'));
const SERVER_DIST = path.join(repoRoot, 'packages', 'server', 'dist', 'index.js');
const MOCK_DIST = path.join(repoRoot, 'packages', 'server', 'dist', 'adapters', 'llm', 'mock.js');

const log = (...a) => console.log('[make-v20]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 剧本：三段 AI 回合——开场叙事 / 叙事+检定指令块（服务端掷骰+审计）/ 续写。
 * 每段 [delta, stop] 结尾分段（MockLlm 的 chat 会一路吞到 stop）。
 */
function buildScript(directive) {
  return [
    { delta: '烛火晃了晃，空气里有旧木头和灰尘的味道。' },
    { stop: true },
    { delta: '守秘人压低声音：「都安静——我需要确认一件事。」' },
    { directive },
    { stop: true },
    { delta: '借着灯光，你看清那道痕迹一路延伸向楼梯。' },
    { stop: true },
  ];
}

function connect(port, tag) {
  return new Promise((resolve, reject) => {
    const socket = io(`http://127.0.0.1:${port}`, {
      auth: { protocol: '0.0.0' },
      transports: ['websocket'],
      reconnection: false,
      timeout: 10_000,
    });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (err) => {
      console.error(`[make-v20] ${tag} 连接失败：${err.message}`);
      reject(err);
    });
  });
}

/** 仅 room:join / session:start 有 ack（网关契约）；其余事件一律无 ack 发送 */
function emitAck(socket, event, payload) {
  return Promise.race([
    new Promise((resolve) => socket.emit(event, payload, resolve)),
    sleep(15_000).then(() => ({ ok: false, message: `${event} 15s 无 ack` })),
  ]);
}

/** 无 ack 事件的完成确认：等一个广播事件，超时只告警不中断 */
function waitFor(socket, event, ms = 10_000) {
  return Promise.race([
    new Promise((resolve) => socket.once(event, resolve)),
    sleep(ms).then(() => null),
  ]);
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2), 'utf8');
}

/** 写一个最小合法模组包（COC7 用；5e 团用 examples 的雾桥驿站） */
async function writeModule(modulesDir, id, rulebook, sceneName, fact) {
  const dir = path.join(modulesDir, id);
  await mkdir(dir, { recursive: true });
  await writeJson(path.join(dir, 'manifest.json'), {
    id,
    name: id,
    version: '1.0.0',
    rulebook,
    apiVersion: '1',
    entry: { kpCard: 'kp-card.json', worldBook: 'worldbook.json', initState: 'init-state.json' },
  });
  await writeJson(path.join(dir, 'kp-card.json'), {
    spec: 'chara_card_v3',
    data: {
      name: '守秘人',
      description: '只叙述，不宣告判定。所有判定通过指令块请求。',
      scenario: '',
      first_mes: '',
      mes_example: '',
      extensions: { aidle: { rulebook } },
    },
  });
  await writeJson(path.join(dir, 'worldbook.json'), {
    entries: [
      {
        uid: 1,
        key: ['旧宅'],
        keysecondary: [],
        selectiveLogic: 0,
        content: '镇郊的旧宅，主人三十年前失踪。钥匙由村长保管。',
        position: 'after_char',
        order: 1,
        weight: 100,
        constant: false,
        disabled: false,
      },
    ],
  });
  await writeJson(path.join(dir, 'init-state.json'), {
    scene: { name: sceneName, time: '1928 年秋夜', publicDesc: '门厅积灰，烛光摇晃。' },
    facts: [fact],
  });
}

const COC7_SHEET = {
  rulebook: 'coc7',
  playerName: '爱丽丝',
  occupation: '侦探',
  str: 50,
  con: 55,
  siz: 45,
  dex: 70,
  app: 60,
  int: 75,
  pow: 65,
  edu: 80,
  luck: 55,
  hp: 10,
  mp: 13,
  san: 55,
  db: '0',
  build: '0',
  skills: { 侦查: 60, 图书馆使用: 70, 聆听: 55 },
};

const DND5E_SHEET = {
  rulebook: 'dnd5e',
  playerName: '波尔',
  occupation: '战士/人类',
  abilities: { str: 16, dex: 14, con: 14, int: 10, wis: 12, cha: 8 },
  proficiencyBonus: 2,
  ac: 16,
  hp: { max: 22, current: 22 },
  proficientSkills: ['运动', '威吓'],
  proficientSaves: ['str', 'con'],
};

const TEAMS = [
  {
    name: 'coc7-team',
    moduleId: 'mod-haunted-house',
    rulebook: 'coc7',
    sheet: COC7_SHEET,
    directive: {
      op: 'check',
      target: 'pc:爱丽丝',
      skill: '聆听',
      difficulty: 'normal',
      label: '听墙外',
    },
    rolls: [
      { expr: '1d100', label: '侦查' },
      { expr: '1d100', hidden: true, label: '幸运' },
    ],
  },
  {
    name: 'dnd5e-team',
    moduleId: 'fogbridge-5e',
    rulebook: 'dnd5e',
    sheet: DND5E_SHEET,
    directive: {
      op: 'check',
      target: 'pc:波尔',
      skill: '察觉',
      difficulty: 'normal',
      label: '察觉雾中人影',
    },
    rolls: [{ expr: '1d20+2', label: '先攻试骰' }],
  },
];

/** 跑一段完整团流程并留下真实存档 */
async function runCampaign(team) {
  const dataDir = path.join(staging, team.name, 'data');
  await mkdir(dataDir, { recursive: true });

  if (team.moduleId === 'fogbridge-5e') {
    // 5e 团直接用随包分发的示例模组（真实消费路径）
    await cp(
      path.join(repoRoot, 'examples', 'modules', 'fogbridge-5e'),
      path.join(dataDir, 'modules', 'fogbridge-5e'),
      {
        recursive: true,
      },
    );
  } else {
    await writeModule(
      path.join(dataDir, 'modules'),
      team.moduleId,
      team.rulebook,
      '旧宅门厅',
      '大门从内侧闩上了',
    );
  }

  const { createServer } = await import(pathToFileURL(SERVER_DIST).href);
  const { createMockLlm } = await import(pathToFileURL(MOCK_DIST).href);
  const mock = createMockLlm({ script: buildScript(team.directive) });
  const app = await createServer({ dataDir, logger: false, llm: mock });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = app.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  log(`  server on :${port}`);

  // socket 提出作用域：finally 先断连接再关 server（websocket 不断，close 不返回）
  let host;
  let player;
  try {
    const room = await (
      await fetch(`${base}/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: team.rulebook === 'coc7' ? '旧宅夜谈（COC7）' : '雾桥驿站（5e）',
        }),
      })
    ).json();

    host = await connect(port, 'host');
    const hostJoin = await emitAck(host, 'room:join', {
      inviteCode: room.inviteCode,
      name: 'KP',
      hostToken: room.hostToken,
    });
    if (!hostJoin.ok) throw new Error(`host join: ${hostJoin.message}`);

    const loadRes = await fetch(`${base}/modules`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ moduleId: team.moduleId }),
    });
    if (loadRes.status !== 201) throw new Error(`module load: ${loadRes.status}`);

    player = await connect(port, 'player');
    const ack = await emitAck(player, 'room:join', {
      inviteCode: room.inviteCode,
      name: team.sheet.playerName,
    });
    if (!ack.ok) throw new Error(`player join: ${ack.message}`);
    const declareRes = await fetch(`${base}/rooms/${room.id}/pcs/${ack.memberId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sheet: team.sheet, source: 'manual' }),
    });
    if (declareRes.status !== 201) throw new Error(`declare: ${declareRes.status}`);

    const startAck = await emitAck(host, 'session:start', {
      moduleId: team.moduleId,
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
    if (!startAck.ok) throw new Error(`session:start: ${startAck.message}`);
    await sleep(300);

    // IC ×2（AI 自动触发，MockLlm 回叙事）→ 指令块回合 → 玩家掷骰 → 状态编辑 → 快照
    for (const content of ['我们举着灯走进门厅。', '墙上的抓痕是怎么回事？']) {
      player.emit('msg:send', { type: 'ic', content });
      await sleep(600);
    }
    player.emit('msg:send', { type: 'ic', content: '我贴墙仔细听外面的动静。' });
    await sleep(400);
    host.emit('ai:invoke', {}); // 无 ack：等本回合 narration:done
    await waitFor(host, 'narration:done', 20_000);

    for (const roll of team.rolls) {
      player.emit('dice:roll', roll); // 无 ack：等骰子消息广播
      await sleep(400);
    }

    const stateRes = await fetch(`${base}/rooms/${room.id}/state`);
    const { stateBoard } = await stateRes.json();
    host.emit('state:update', {
      // 无 ack：等状态板广播
      expectedVersion: stateBoard.version,
      patch: { scene: { ...stateBoard.scene, publicDesc: '抓痕延伸向二楼，楼梯在尽头拐角。' } },
    });
    await waitFor(host, 'state:broadcast', 10_000);

    host.emit('state:snapshot', {});
    await sleep(500);
  } finally {
    host?.close();
    player?.close();
    await app.close();
  }
  return dataDir;
}

/** 把 v3 信封剥回 v2.0 形态：无 schemaVersion 根字段；members.json 退回裸数组 */
async function stripToV20Shape(dataDir) {
  const ARCHIVE_RE =
    /rooms\/[^/]+\/(room|members|roster)\.json$|rooms\/[^/]+\/sessions\/[^/]+\/(session|state)\.json$/;
  let stripped = 0;

  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
        continue;
      }
      const rel = path.relative(dataDir, abs).replaceAll('\\', '/');
      if (!rel.endsWith('.json') || !ARCHIVE_RE.test(rel)) continue;
      const doc = JSON.parse(await readFile(abs, 'utf8'));
      if (rel.endsWith('members.json') && Array.isArray(doc.members)) {
        await writeFile(abs, `${JSON.stringify(doc.members, null, 2)}\n`, 'utf8');
      } else {
        const { schemaVersion: _v, ...payload } = doc;
        await writeFile(abs, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      }
      stripped += 1;
    }
  }
  await walk(dataDir);
  return stripped;
}

const staging = await mkdtemp(path.join(tmpdir(), 'bv-v20-archives-'));
await mkdir(outRoot, { recursive: true });

for (const team of TEAMS) {
  log(`生成 ${team.name}（${team.rulebook}）`);
  const dataDir = await runCampaign(team);
  const stripped = await stripToV20Shape(dataDir);
  log(`  已剥回 v2.0 形态：${stripped} 个存档`);
  await cp(path.join(staging, team.name), path.join(outRoot, team.name), { recursive: true });
  log(`  产物：${path.join(outRoot, team.name, 'data')}`);
}

await rm(staging, { recursive: true, force: true });
log('完成。下一步：pnpm aidle-migrate <输出目录>/<team>/data 逐团干跑。');
