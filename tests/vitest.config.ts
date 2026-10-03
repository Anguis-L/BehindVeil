import { defineConfig } from 'vitest/config';

// 跨里程碑的集成载体：黄金用例（golden/）、架构约束（architecture/）、
// 崩溃夹具（crash/，其中的 .mjs 由包内测试以子进程方式调用）。
// perf/ 不在此列（T-M10-00）：性能基准用 tests/perf 专属配置单跑，见其 vitest.config.ts。
export default defineConfig({
  test: {
    name: 'integration',
    include: ['**/*.test.ts'],
    exclude: ['perf/**'],
    testTimeout: 30_000,
  },
});
