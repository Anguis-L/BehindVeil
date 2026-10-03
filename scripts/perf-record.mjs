/**
 * perf:record 包装器（T-M10-00）：以 AIDLE_PERF_RECORD=1 再入 pnpm perf。
 * 单独成脚本是为了跨 shell（win32 cmd 不认 `VAR=1 cmd` 前缀语法）。
 */

import { spawnSync } from 'node:child_process';

process.env.AIDLE_PERF_RECORD = '1';
const result = spawnSync('pnpm', ['perf'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: process.env,
});
process.exit(result.status ?? 1);
