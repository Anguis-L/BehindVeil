/**
 * 热备崩溃注入子进程夹具（T-M10-04，沿用 §12.5 故障注入口径）。
 *
 * 用法：node backup-harness.mjs <dataDir> <backupDir>
 *
 * 构造 BackupSyncer（dist 构建产物）执行一轮 syncOnce 后退出。
 * 崩溃点由存储层测试钩子决定（生产路径不读）：
 *   AIDLE_TEST_CRASH_AT=1 → 死于游标落盘（JsonStore tmp fsync 后、rename 前）。
 * 选择该注入点的语义：本轮 JSONL 追加已写入备份（未记游标）——
 * 复现「崩溃中断于『备份超前于游标』」的经典续传场景。
 */

const dataDir = process.argv[2];
const backupDir = process.argv[3];

async function loadModule(rel) {
  const url = new URL(`../../packages/server/dist/${rel}`, import.meta.url);
  try {
    return await import(url.href);
  } catch (cause) {
    console.error(`[harness] 无法加载构建产物 ${url.href}，请先执行 pnpm build`);
    throw cause;
  }
}

const { BackupSyncer } = await loadModule('adapters/backup/syncer.js');
const { createDataLayout } = await loadModule('adapters/storage/layout.js');

const syncer = new BackupSyncer({
  dataDir,
  backupDir,
  layout: createDataLayout(dataDir),
});
const report = await syncer.syncOnce();
console.error(`[harness] done ${JSON.stringify(report)}`);
