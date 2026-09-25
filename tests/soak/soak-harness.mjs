/**
 * Soak 被测进程夹具（TC-NFR-05-003，测试文档 §12.3）。
 *
 * 用法：node soak-harness.mjs <dataDir>
 *
 * 起真实 server（Fastify + 管理面 REST + Socket.IO 网关）监听随机端口，每 500ms
 * 把端口与自身 RSS 采样以 appendFileSync 写入 <dataDir>/soak-events.jsonl。
 * 压测结束时由父测试直接终止进程（杀进程即预期退出方式，跨平台无需优雅协议：
 * win32 上 TerminateProcess 不可捕获，同步文件写入保证事件不丢）。
 * 断言（0 error:app / seq 连续 / RSS 增长）全部在父测试完成。
 */

import { appendFileSync } from 'node:fs';
import path from 'node:path';

const dataDir = process.argv[2];
const EVENTS_FILE = path.join(dataDir, 'soak-events.jsonl');

function event(payload) {
  appendFileSync(EVENTS_FILE, `${JSON.stringify(payload)}\n`, 'utf8');
}

async function loadServer() {
  const url = new URL('../../packages/server/dist/index.js', import.meta.url);
  try {
    return await import(url.href);
  } catch (cause) {
    console.error(`[harness] 无法加载构建产物 ${url.href}，请先执行 pnpm build`);
    throw cause;
  }
}

const { createServer } = await loadServer();
const app = await createServer({ dataDir, logger: false });
await app.listen({ port: 0, host: '127.0.0.1' });
event({ event: 'listening', port: app.server.address().port });

// 进程常驻直到被父测试终止（杀进程即预期退出，见头注）；事件循环由 listen 句柄保持
setInterval(() => {
  event({ event: 'rss', ts: Date.now(), rss: process.memoryUsage().rss });
}, 500);
