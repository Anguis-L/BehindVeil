import { defineConfig } from 'vitest/config';

// 跨里程碑的集成载体：黄金用例（golden/）、架构约束（architecture/）、
// 崩溃夹具（crash/，其中的 .mjs 由包内测试以子进程方式调用）。
export default defineConfig({
  test: {
    name: 'integration',
    include: ['**/*.test.ts'],
    testTimeout: 30_000,
  },
});
