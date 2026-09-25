/**
 * 网关链路 WAP 故障注入夹具（TC-NFR-06-004，测试文档 §12.5）。
 *
 * 用法：node gateway-harness.mjs <dataDir> run
 *       node gateway-harness.mjs <dataDir> verify <inviteCode> <hostToken>
 *
 * run：起真实 server（Fastify + 管理面 REST + Socket.IO 网关），执行最小发消息链路：
 *   REST 建房 → Host 进房 → 开团 → 发 1 条 IC。
 * 全局持久化写计数构成（见 crash-hook，AIDLE_TEST_CRASH_AT 语义「第 n 次写完成后自杀」）：
 *   #1 room.json（建房）#2 members.json（进房）
 *   #3/#4/#5 session.json + state.json + room.json（开团）
 *   #6 开团 notice（messages.jsonl append）#7 IC 消息 append
 * 配 AIDLE_TEST_CRASH_AT=7：进程死于第 7 次写 = IC 的 fsync 之后、
 * persistAndDeliver 的广播之前——恰好是 WAP 不变式（凡已广播者必已落盘）的注入点。
 *
 * verify：同一 dataDir 重启（触发启动恢复），Host 凭 hostToken 重连并携带 lastSeq=0，
 * 收集服务端补发，把收到的消息写入事件文件。
 *
 * 关键事件以 appendFileSync 落 <dataDir>/harness-events.jsonl：
 * SIGKILL 时管道缓冲会丢，同步文件写入不会；父测试从该文件取断言材料。
 */

import { appendFileSync } from 'node:fs';
import path from 'node:path';

const dataDir = process.argv[2];
const phase = process.argv[3];
const EVENTS_FILE = path.join(dataDir, 'harness-events.jsonl');

function event(payload) {
  appendFileSync(EVENTS_FILE, `${JSON.stringify(payload)}\n`, 'utf8');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadServer() {
  const url = new URL('../../packages/server/dist/index.js', import.meta.url);
  try {
    return await import(url.href);
  } catch (cause) {
    console.error(`[harness] 无法加载构建产物 ${url.href}，请先执行 pnpm build`);
    throw cause;
  }
}

async function loadShared() {
  const url = new URL('../../packages/shared/dist/index.js', import.meta.url);
  return import(url.href);
}

async function main() {
  const { createServer } = await loadServer();
  const { PROTOCOL_VERSION } = await loadShared();

  const app = await createServer({ dataDir, logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = app.server.address().port;
  event({ event: 'listening', port });

  const { io } = await import('socket.io-client');
  const baseUrl = `http://127.0.0.1:${port}`;

  if (phase === 'run') {
    const res = await fetch(`${baseUrl}/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'WAP 注入房' }),
    });
    const room = await res.json();
    event({ event: 'room', id: room.id, inviteCode: room.inviteCode, hostToken: room.hostToken });

    const socket = io(baseUrl, {
      auth: { protocol: PROTOCOL_VERSION },
      transports: ['websocket'],
      reconnection: false,
    });
    await new Promise((resolve, reject) => {
      socket.on('connect', resolve);
      socket.on('connect_error', reject);
    });

    const joinAck = await new Promise((resolve) =>
      socket.emit(
        'room:join',
        { inviteCode: room.inviteCode, name: 'KP', hostToken: room.hostToken },
        resolve,
      ),
    );
    event({ event: 'join-ack', ok: joinAck.ok, role: joinAck.role });

    const sessionAck = await new Promise((resolve) =>
      socket.emit(
        'session:start',
        {
          moduleId: 'mod-wap',
          settings: {
            provider: 'openai-compat',
            model: 'mock',
            temperature: 0.7,
            maxHistoryMessages: 40,
            worldBookBudgetTokens: 2000,
            scanDepth: 4,
          },
        },
        resolve,
      ),
    );
    event({ event: 'session-ack', ok: sessionAck.ok, sessionId: sessionAck.session?.id });

    socket.on('msg:broadcast', (payload) => {
      event({ event: 'ic-broadcast', seq: payload?.msg?.seq, type: payload?.msg?.type });
    });

    socket.emit('msg:send', { type: 'ic', content: 'WAP 注入消息' });
    event({ event: 'ic-sent' });

    // 若 WAP 注入点正确，进程在 IC append 的 fsync 后立即被杀，走不到这里；
    // 走到 post-ic 即说明计数漂移或注入未生效（父测试据此判失败）。
    await sleep(800);
    event({ event: 'post-ic' });
    socket.close();
    await app.close();
    return;
  }

  if (phase === 'verify') {
    const inviteCode = process.argv[4];
    const hostToken = process.argv[5];

    const socket = io(baseUrl, {
      auth: { protocol: PROTOCOL_VERSION },
      transports: ['websocket'],
      reconnection: false,
    });
    await new Promise((resolve, reject) => {
      socket.on('connect', resolve);
      socket.on('connect_error', reject);
    });

    const joinAck = await new Promise((resolve) =>
      socket.emit('room:join', { inviteCode, name: 'KP', hostToken, lastSeq: 0 }, resolve),
    );
    event({ event: 'join-ack', ok: joinAck.ok, lastSeq: joinAck.lastSeq });

    const replayed = [];
    socket.on('msg:broadcast', (payload) => {
      replayed.push({
        seq: payload?.msg?.seq,
        type: payload?.msg?.type,
        content: payload?.msg?.content,
      });
    });
    await sleep(800);
    event({ event: 'replayed', messages: replayed });
    socket.close();
    await app.close();
    return;
  }

  throw new Error(`未知 phase：${phase}`);
}

await main();
// 正常跑完的标记：父进程据此区分「跑完退出」与「被强制终止」
console.error('[harness] done');
