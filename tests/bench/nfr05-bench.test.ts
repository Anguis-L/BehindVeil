import { describe, expect, it } from 'vitest';
import { scanWorldBook } from '../../packages/server/dist/domain/worldbook/scan.js';
import { buildPrompt } from '../../packages/server/dist/pipeline/index.js';
import type { PipelineInput } from '../../packages/server/dist/pipeline/index.js';
import { createHeuristicTokenizer } from '../../packages/server/dist/pipeline/tokenizer.js';
import type { WorldBook, WorldBookEntry } from '../../packages/shared/dist/domain.js';
import type { Message } from '../../packages/shared/dist/message.js';

/**
 * T-M2-08 性能基准（NFR-05，测试文档 §6.2 TC-NFR-05-001/002）。
 * 夹具 F-01（§2）：500 条目世界书，覆盖四类 selectiveLogic、正则、constant、kpOnly、递归引用。
 * 阈值：扫描 p95 < 50ms（500 条目 × 4 条消息）；管线整体 p95 < 100ms。
 * 扫描与管线均为纯函数无 IO；预热后测量取 p95——单次量级在毫秒上下，阈值是数量级护栏，
 * 给 CI 波动留足裕度，回归到两位数耗时才会失败。
 */

function ic(seq: number, content: string): Message {
  return {
    seq,
    ts: '2026-09-25T00:00:00.000Z',
    sessionId: 'ses_bench',
    type: 'ic',
    senderId: 'member_1',
    content,
  };
}

/** F-01：500 条目 = 475 常规（四类 selectiveLogic 轮转）+ 5 正则 + 5 constant + 5 kpOnly + 10 递归对 */
function buildF01WorldBook(): WorldBook {
  const entries: WorldBookEntry[] = [];
  let uid = 0;
  const make = (patch: Partial<WorldBookEntry>): WorldBookEntry => ({
    uid: uid++,
    key: [],
    keysecondary: [],
    selectiveLogic: 0,
    content: '条目背景：这里发生过许多故事。',
    position: 'after_char',
    order: 0,
    weight: 100,
    constant: false,
    disabled: false,
    ...patch,
  });

  for (let i = 0; i < 475; i += 1) {
    entries.push(
      make({
        key: [`地点${i}号`],
        keysecondary: i % 2 === 0 ? [`标记${i}`] : [],
        selectiveLogic: (i % 4) as WorldBookEntry['selectiveLogic'],
        order: i,
      }),
    );
  }
  for (let i = 0; i < 5; i += 1) {
    entries.push(make({ key: [`/灯塔\\d+_${i}/`], order: i }));
  }
  for (let i = 0; i < 5; i += 1) {
    entries.push(make({ constant: true, content: `常驻条目 ${i}：小镇的底色设定。`, order: i }));
  }
  for (let i = 0; i < 5; i += 1) {
    entries.push(
      make({ extensions: { kpOnly: true }, content: `模组真相 ${i}：不可言说之物。`, order: i }),
    );
  }
  for (let i = 0; i < 5; i += 1) {
    entries.push(make({ key: [`回环${i}`], content: `回环线索 ${i}：指向暗语${i}。`, order: i }));
    entries.push(make({ key: [`暗语${i}`], content: `暗语条目 ${i}：终于闭环。`, order: i }));
  }
  return { entries };
}

const BENCH_MESSAGES: Message[] = [
  ic(1, '一行人抵达了地点7号，稍作休整。'),
  ic(2, '远处的灯塔42_1在雾中若隐若现。'),
  ic(3, '有人提起回环0的传闻。'),
  ic(4, '今晚就在营地休息。'),
];

function buildBenchInput(worldBook: WorldBook): PipelineInput {
  return {
    session: {
      provider: 'openai-compat',
      model: 'deepseek-chat',
      temperature: 0.8,
      maxHistoryMessages: 40,
      worldBookBudgetTokens: 2000,
      scanDepth: 8,
      contextWindowTokens: 32_768,
      outputReserveTokens: 2_048,
    },
    kpCard: {
      spec: 'chara_card_v3',
      data: {
        name: '守秘人',
        description: '你是本团守秘人（KP）：负责叙事推进与扮演 NPC。',
        scenario: '',
        first_mes: '',
        mes_example: '',
        extensions: { aidle: { rulebook: 'coc7' } },
      },
    },
    messages: BENCH_MESSAGES,
    stateBoard: {
      version: 1,
      pcs: {},
      scene: { name: '营地', time: '1924-03-12 深夜', publicDesc: '雾气渐浓' },
      facts: ['一行人已抵达小镇'],
      updatedAt: '2026-09-25T00:00:00.000Z',
    },
    worldBook,
    pcRoster: '',
    synopsis: '',
  };
}

/** p95（升序第 95 百分位， ceil 索引）；空样本返回 NaN 使断言自然失败 */
function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index] ?? Number.NaN;
}

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
