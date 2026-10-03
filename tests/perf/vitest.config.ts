import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * tests/perf 专用配置（T-M10-00）：NFR-10 基线套件与常规测试分离运行——
 * - `pnpm perf` / `pnpm perf:record`：只跑本目录（性能测量需要安静的进程环境，
 *   与其他测试并行会互相污染采样）；
 * - `pnpm test:coverage`：经由 tests/vitest.config.ts 的 exclude('perf/**') 跳过本目录，
 *   覆盖率插桩会扭曲基准值，不能混跑。
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: 'perf',
    include: ['**/*.test.ts'],
    testTimeout: 240_000,
    hookTimeout: 60_000,
  },
});
