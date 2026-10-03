import { describe, expect, it } from 'vitest';
// 直接吃源码：吃 dist 的话，源码改了不重新构建就测不到（且 dist 缺失会静默降级）
import { scanWorldBook } from '../../packages/server/src/domain/worldbook/scan.js';
import { buildPrompt } from '../../packages/server/src/pipeline/index.js';
import { createHeuristicTokenizer } from '../../packages/server/src/pipeline/tokenizer.js';
import { BENCH_MESSAGES, buildBenchInput, buildF01WorldBook, p95 } from './fixture-f01.js';

/**
 * T-M2-08 性能基准（NFR-05，测试文档 §6.2 TC-NFR-05-001/002）。
 * 夹具 F-01（§2）见 fixture-f01.ts（v3 T-M10-00 抽出，与 tests/perf 共用）。
 * 阈值：扫描 p95 < 50ms（500 条目 × 4 条消息）；管线整体 p95 < 100ms。
 * 扫描与管线均为纯函数无 IO；预热后测量取 p95——单次量级在毫秒上下，阈值是数量级护栏，
 * 给 CI 波动留足裕度，回归到两位数耗时才会失败。
 */

describe('F-01 夹具规格（测试文档 §2）', () => {
  it('500 条目，覆盖四类 selectiveLogic / 正则 / constant / kpOnly / 递归', () => {
    const book = buildF01WorldBook();

    expect(book.entries).toHaveLength(500);
    expect(book.entries.filter((e) => e.constant)).toHaveLength(5);
    expect(book.entries.filter((e) => e.extensions?.kpOnly === true)).toHaveLength(5);
    expect(book.entries.filter((e) => e.key.some((k) => k.startsWith('/')))).toHaveLength(5);
    const logicSet = new Set(
      book.entries
        .filter((e) => !e.constant && e.extensions?.kpOnly !== true)
        .map((e) => e.selectiveLogic),
    );
    expect([...logicSet].sort()).toEqual([0, 1, 2, 3]);

    // 递归链路：源条目（回环N）命中后，其 content 引出目标条目（暗语N）
    const hits = scanWorldBook(['有人提起回环2的传闻。'], book);
    expect(hits.some((h) => h.entry.key.includes('暗语2'))).toBe(true);
  });
});

describe('扫描基准（TC-NFR-05-001）', () => {
  it('F-01 500 条目 × 4 条消息，p95 < 50ms', () => {
    const book = buildF01WorldBook();
    const texts = BENCH_MESSAGES.map((m) => m.content);
    for (let i = 0; i < 20; i += 1) scanWorldBook(texts, book); // 预热（JIT/缓存）

    const samples: number[] = [];
    for (let i = 0; i < 200; i += 1) {
      const t0 = performance.now();
      scanWorldBook(texts, book);
      samples.push(performance.now() - t0);
    }

    expect(p95(samples)).toBeLessThan(50);
  });
});

describe('管线整体基准（TC-NFR-05-002）', () => {
  it('F-01 基准集整条管线（S1–S7），p95 < 100ms', () => {
    const tokenizer = createHeuristicTokenizer();
    const input = buildBenchInput(buildF01WorldBook());
    for (let i = 0; i < 10; i += 1) buildPrompt(input, tokenizer); // 预热

    const samples: number[] = [];
    for (let i = 0; i < 100; i += 1) {
      const t0 = performance.now();
      buildPrompt(input, tokenizer);
      samples.push(performance.now() - t0);
    }

    expect(p95(samples)).toBeLessThan(100);
  });
});
