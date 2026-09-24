/**
 * 故障注入钩子（测试文档 §2 / §12.5，服务 TC-NFR-06-001/003/004/006）。
 *
 * `AIDLE_TEST_CRASH_AT=<n>`：存储层第 n 次持久化写完成后立即以 SIGKILL 终止进程
 * （等效 kill -9），用于断电/崩溃恢复测试。未设置该变量时零开销直通。
 *
 * 注入点约定：
 * - JsonlStore.append：整行写入 + fsync 完成后（已确认条数必须全在；广播必在落盘之后）；
 * - JsonStore.write：tmp 文件 fsync 之后、rename 之前（rename 前中断 → 旧文件完好）。
 */
let writeCount = 0;

export function maybeCrashAfterWrite(): void {
  writeCount += 1;
  const at = Number(process.env.AIDLE_TEST_CRASH_AT);
  if (Number.isInteger(at) && at > 0 && writeCount === at) {
    process.kill(process.pid, 'SIGKILL');
  }
}
