import { defineConfig } from 'vitest/config';

// 覆盖率阈值对齐 TDD §10 (NFR-09)：≥ 85%
// 骨架阶段代码量极少，M0 落地后若覆盖率不足会在此处直接 fail。
const COVERAGE_MIN = Number(process.env.COVERAGE_MIN ?? 85);

export default defineConfig({
  test: {
    // 跨包集成载体：tests/（黄金用例、架构约束、崩溃夹具），见 tests/vitest.config.ts
    projects: ['packages/*', 'tests'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        'packages/*/src/**/*.test.ts',
        'packages/web/src/main.ts', // 仅做 DOM 挂载，不参与单测
        '**/dist/**',
      ],
      thresholds: {
        lines: COVERAGE_MIN,
        functions: COVERAGE_MIN,
        statements: COVERAGE_MIN,
        branches: COVERAGE_MIN,
      },
    },
  },
});
