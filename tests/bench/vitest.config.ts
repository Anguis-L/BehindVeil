import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * tests/bench 专用配置（与 tests/perf 同款处置）：
 * - `pnpm bench`：只跑本目录（基准计时需要安静的进程环境——与其他测试并行会互相
 *   污染采样。实测同机全量套件下召回 p95 53–66ms，单跑 30ms 量级，绝对预算 50ms
 *   在并行下必红；这与 M10 把 fsync p99 基准搬出并行套件是同一条理由）；
 * - 集成工程 tests/vitest.config.ts 排除 bench/**，覆盖率插桩同样会扭曲基准值。
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: 'bench',
    include: ['**/*.test.ts'],
    testTimeout: 240_000,
    hookTimeout: 60_000,
  },
});
