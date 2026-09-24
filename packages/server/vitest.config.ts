import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'server',
    include: ['src/**/*.test.ts'],
    // 30s：本工程含子进程故障注入（crash-recovery）与 Fastify 装配根用例；
    // 全量覆盖率跑时依赖图转换+插桩的冷加载曾触及 5s 默认值（dist 直测 createServer 全程 <1s，非功能问题），
    // 对齐 tests/ 工程的集成口径。
    testTimeout: 30_000,
  },
});
