import type { WorldBook, WorldBookEntry } from '../../packages/shared/src/domain.js';
import type { Message } from '../../packages/shared/src/message.js';
import type { PipelineInput } from '../../packages/server/src/pipeline/index.js';

/**
 * F-01 性能基准夹具（测试文档 §2）：500 条目世界书，覆盖四类 selectiveLogic、
 * 正则、constant、kpOnly、递归引用。原内联于 nfr05-bench.test.ts，
 * v3 T-M10-00 抽出供 bench 与 tests/perf 基线套件共用。
 */

export function ic(seq: number, content: string): Message {
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
export function buildF01WorldBook(): WorldBook {
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

export const BENCH_MESSAGES: Message[] = [
  ic(1, '一行人抵达了地点7号，稍作休整。'),
  ic(2, '远处的灯塔42_1在雾中若隐若现。'),
  ic(3, '有人提起回环0的传闻。'),
  ic(4, '今晚就在营地休息。'),
];

export function buildBenchInput(worldBook: WorldBook): PipelineInput {
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
export function p95(samples: number[]): number {
  return percentile(samples, 0.95);
}

/** p50/p99 等通用百分位（升序 ceil 索引）；空样本返回 NaN */
export function percentile(samples: number[], q: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1);
  return sorted[index] ?? Number.NaN;
}
