/**
 * 崩溃注入子进程夹具（测试文档 §2 / §12.5）。
 *
 * 用法：node append-harness.mjs <mode> <target> <count>
 *   mode=jsonl  → 用 JsonlStore 追加 count 条消息
 *   mode=json   → 用 JsonStore 反复整文件原子写 count 次
 *
 * 崩溃点由被测存储层读取环境变量决定（测试专用钩子，生产路径不读）：
 *   AIDLE_TEST_CRASH_AT=<n>            第 n 次写完成后立即终止进程（等效 kill -9）
 *   AIDLE_TEST_CRASH_PHASE=before-rename  终止点前移到 rename 之前（仅 JSON 原子写生效）
 *
 * 之所以跑在独立进程：真正的 SIGKILL 不能被 try/catch 拦截，
 * 只有「进程被杀死后重新打开」才能验证写前持久化（WAP）确实落盘。
 */

const mode = process.argv[2];
const target = process.argv[3];
const count = Number(process.argv[4] ?? '1');

async function loadStore(module) {
  const url = new URL(`../../packages/server/dist/adapters/storage/${module}`, import.meta.url);
  try {
    return await import(url.href);
  } catch (cause) {
    console.error(`[harness] 无法加载构建产物 ${url.href}，请先执行 pnpm build`);
    throw cause;
  }
}

async function main() {
  if (mode === 'jsonl') {
    const { JsonlStore } = await loadStore('jsonl-store.js');
    const store = new JsonlStore(target);
    for (let i = 1; i <= count; i += 1) {
      await store.append({
        seq: i,
        ts: new Date().toISOString(),
        sessionId: 'ses_crash',
        type: 'ic',
        senderId: 'member_1',
        content: `第 ${i} 条消息`,
      });
    }
    return;
  }

  if (mode === 'json') {
    const { JsonStore } = await loadStore('json-store.js');
    const store = new JsonStore(target);
    for (let i = 1; i <= count; i += 1) {
      await store.write({ version: i, note: `第 ${i} 版` });
    }
    return;
  }

  throw new Error(`未知模式：${mode}`);
}

await main();
// 正常跑完的标记：父进程据此区分「跑完退出」与「被强制终止」
console.error('[harness] done');
