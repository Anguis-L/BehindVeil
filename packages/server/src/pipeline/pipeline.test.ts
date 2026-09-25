import { describe, expect, it } from 'vitest';
import { buildPrompt, META_INSTRUCTION } from './index.js';
import type { PipelineInput } from './index.js';

/**
 * 管线测试（T-M0-07 骨架 + T-M2-03/04 全量行为，TDD §5.1）。
 * 骨架验收：阶段齐全、纯函数、trace 可序列化、tokenizer 注入。
 * 行为验收：S1 速查、S2 状态块、S3 扫描深度、S4 预算、S5 裁剪+梗概（D-01）、
 * S6 position 插入、S7 硬顶回退；黄金用例集（tests/golden/）另以快照固化行为。
 */

const settings = {
  provider: 'openai-compat',
  model: 'deepseek-chat',
  temperature: 0.8,
  maxHistoryMessages: 40,
  worldBookBudgetTokens: 2000,
  scanDepth: 4,
  contextWindowTokens: 32_768,
  outputReserveTokens: 2_048,
};

const kpCard = {
  spec: 'chara_card_v3' as const,
  data: {
    name: '守秘人',
    description: '你是守秘人：叙事、扮演 NPC、只在必要时请求检定。',
    scenario: '深夜书房',
    first_mes: '灯亮了。',
    mes_example: '',
    extensions: { aidle: { rulebook: 'coc7' as const } },
  },
};

function msg(seq: number, content: string): PipelineInput['messages'][number] {
  return {
    seq,
    ts: '2026-09-25T00:00:00.000Z',
    sessionId: 'ses_1',
    type: 'ic',
    senderId: 'member_1',
    content,
  };
}

function wbEntry(
  overrides: Record<string, unknown>,
): PipelineInput['worldBook']['entries'][number] {
  return {
    uid: 1,
    key: [],
    keysecondary: [],
    selectiveLogic: 0,
    content: '条目内容',
    position: 'after_char',
    order: 0,
    weight: 100,
    constant: false,
    disabled: false,
    ...overrides,
  } as PipelineInput['worldBook']['entries'][number];
}

function makeInput(overrides: Partial<PipelineInput> = {}): PipelineInput {
  return {
    session: settings,
    kpCard,
    messages: [msg(1, '我推开书房的门。')],
    stateBoard: {
      version: 1,
      pcs: {},
      scene: { name: '书房', time: '1924-03-12 夜', publicDesc: '壁炉噼啪作响' },
      facts: ['门从内侧反锁'],
      updatedAt: '2026-09-25T00:00:00.000Z',
    },
    worldBook: { entries: [] },
    pcRoster: '张三（记者）',
    synopsis: '',
    ...overrides,
  };
}

const tokenizer = { count: (text: string): number => text.length };

describe('buildPrompt 阶段骨架（TDD §5.1 S1–S7）', () => {
  const input = makeInput();

  it('按 S1→S7 顺序产出七个阶段', () => {
    const trace = buildPrompt(input, tokenizer);

    expect(trace.stages.map((stage) => stage.name.slice(0, 2))).toEqual([
      'S1',
      'S2',
      'S3',
      'S4',
      'S5',
      'S6',
      'S7',
    ]);
  });

  it('每个阶段记录非负 token 数（FR-13 预览依赖）', () => {
    const trace = buildPrompt(input, tokenizer);

    for (const stage of trace.stages) {
      expect(typeof stage.tokenCount).toBe('number');
      expect(stage.tokenCount).toBeGreaterThanOrEqual(0);
    }
  });

  it('产出可供 LLM 使用的 messages 数组', () => {
    const trace = buildPrompt(input, tokenizer);

    expect(trace.messages).toHaveLength(2);
    expect(trace.messages[0]?.role).toBe('system');
    expect(trace.messages[1]?.role).toBe('user');
  });

  it('token 计数走注入的 Tokenizer（D-06：接口可替换）', () => {
    let calls = 0;
    const spy = {
      count: (text: string): number => {
        calls += 1;
        return text.length;
      },
    };

    buildPrompt(input, spy);

    expect(calls).toBeGreaterThan(0);
  });
});

describe('buildPrompt 纯函数性（黄金用例的前提）', () => {
  const input = makeInput();

  it('相同输入产出相同 trace', () => {
    expect(buildPrompt(input, tokenizer)).toEqual(buildPrompt(input, tokenizer));
  });

  it('不修改入参（管线不得有副作用）', () => {
    const snapshot = structuredClone(input);

    buildPrompt(input, tokenizer);

    expect(input).toEqual(snapshot);
  });

  it('trace 可完整 JSON 序列化（kp:promptPreview 需要传输）', () => {
    const trace = buildPrompt(input, tokenizer);

    expect(JSON.parse(JSON.stringify(trace))).toEqual(trace);
  });

  it('空历史与空世界书不崩溃（刚开团）', () => {
    const trace = buildPrompt(makeInput({ messages: [] }), tokenizer);

    expect(trace.stages).toHaveLength(7);
    expect(Array.isArray(trace.messages)).toBe(true);
  });
});

describe('S1 骨架（TC-FR-03-003）', () => {
  it('含 KP 人格、规则速查（随卡 rulebook）与元指令', () => {
    const trace = buildPrompt(makeInput(), tokenizer);

    const system = trace.messages[0]?.content ?? '';
    expect(system).toContain('你是守秘人');
    expect(system).toContain('COC7');
    expect(system).toContain(META_INSTRUCTION);
  });

  it('卡未指定 rulebook 时不注入速查段', () => {
    const noRulebook = makeInput({
      kpCard: { ...kpCard, data: { ...kpCard.data, extensions: {} } },
    });
    const trace = buildPrompt(noRulebook, tokenizer);

    expect(trace.messages[0]?.content).not.toContain('检定速查');
  });
});

describe('S2 状态注入（TC-FR-03-003）', () => {
  it('注入 PC 状态、场景与已确立事实', () => {
    const input = makeInput({
      stateBoard: {
        version: 3,
        pcs: {
          mem_1: {
            sheet: {
              playerName: '张三',
              occupation: '记者',
              str: 50,
              con: 60,
              siz: 55,
              dex: 70,
              app: 50,
              int: 75,
              pow: 60,
              edu: 80,
              luck: 55,
              hp: 11,
              mp: 12,
              san: 55,
              db: '0',
              build: '0',
              skills: { 侦查: 60 },
            },
            conditions: ['疯狂(临时)'],
          },
        },
        scene: { name: '书房', time: '1924-03-12 夜', publicDesc: '壁炉噼啪作响' },
        facts: ['门从内侧反锁', '桌上有一封烧焦的信'],
        updatedAt: '2026-09-25T00:00:00.000Z',
      },
    });
    const trace = buildPrompt(input, tokenizer);

    const system = trace.messages[0]?.content ?? '';
    expect(system).toContain('【状态板 v3】');
    expect(system).toContain('场景：书房｜1924-03-12 夜');
    expect(system).toContain(
      '- [mem_1] 张三（记者）HP 11｜MP 12｜SAN 55｜DB 0｜体格 0｜状态：疯狂(临时)',
    );
    expect(system).toContain('- 门从内侧反锁');
    expect(trace.stages[1]?.detail).toMatchObject({ pcCount: 1, factCount: 2, injected: true });
  });

  it('全空状态板不注入', () => {
    const trace = buildPrompt(
      makeInput({
        stateBoard: {
          version: 0,
          pcs: {},
          scene: { name: '', time: '', publicDesc: '' },
          facts: [],
          updatedAt: '2026-09-25T00:00:00.000Z',
        },
      }),
      tokenizer,
    );

    expect(trace.messages[0]?.content).not.toContain('【状态板');
    expect(trace.stages[1]?.detail).toMatchObject({ injected: false });
  });
});

describe('S3 世界书扫描与 S4 预算（TC-FR-07-013/014）', () => {
  it('scanDepth：仅最近 N 条消息参与匹配', () => {
    const input = makeInput({
      session: { ...settings, scanDepth: 1 },
      messages: [msg(1, '码头的雾很重'), msg(2, '书房里很安静')],
      worldBook: { entries: [wbEntry({ uid: 1, key: ['码头'] })] },
    });
    const trace = buildPrompt(input, tokenizer);

    expect(trace.stages[2]?.detail).toMatchObject({ scannedMessageCount: 1, hitUids: [] });

    const flipped = buildPrompt(
      makeInput({
        session: { ...settings, scanDepth: 1 },
        messages: [msg(1, '书房里很安静'), msg(2, '码头的雾很重')],
        worldBook: { entries: [wbEntry({ uid: 1, key: ['码头'] })] },
      }),
      tokenizer,
    );
    expect(flipped.stages[2]?.detail).toMatchObject({ hitUids: [1] });
  });

  it('预算裁剪：weight 降序装入、超预算截断、被裁条目进 trace', () => {
    const input = makeInput({
      messages: [msg(1, '提到码头与灯塔')],
      worldBook: {
        entries: [
          wbEntry({ uid: 1, key: ['码头'], content: 'AAAA'.repeat(10), weight: 200 }),
          wbEntry({ uid: 2, key: ['码头'], content: 'BBBB'.repeat(10), weight: 300, order: 5 }),
          wbEntry({ uid: 3, key: ['灯塔'], content: 'CCCC'.repeat(10), weight: 100 }),
        ],
      },
      session: { ...settings, worldBookBudgetTokens: 45 },
    });
    const trace = buildPrompt(input, tokenizer);

    // weight 降序：uid 2（300）→ uid 1（200）装入（40+40=80 超 45 → 只装 uid 2 前 40+5? 按 cost 45 上限）
    const s4 = trace.stages[3]?.detail as { includedUids: number[]; droppedUids: number[] };
    expect(s4.includedUids[0]).toBe(2);
    expect(s4.droppedUids).toContain(1);
    expect(s4.droppedUids).toContain(3);
  });

  it('budget=0：全部被裁', () => {
    const input = makeInput({
      messages: [msg(1, '提到码头')],
      worldBook: { entries: [wbEntry({ uid: 1, key: ['码头'], content: '内容' })] },
      session: { ...settings, worldBookBudgetTokens: 0 },
    });
    const trace = buildPrompt(input, tokenizer);

    expect(trace.stages[3]?.detail).toMatchObject({ includedUids: [], droppedUids: [1] });
    expect(trace.messages[0]?.content).not.toContain('内容');
  });

  it('同 weight 按 order 稳定排序（TC-FR-07-016）', () => {
    const input = makeInput({
      messages: [msg(1, '码头与灯塔')],
      worldBook: {
        entries: [
          wbEntry({ uid: 1, key: ['码头'], content: '甲', order: 2 }),
          wbEntry({ uid: 2, key: ['码头'], content: '乙', order: 1 }),
        ],
      },
    });
    const trace = buildPrompt(input, tokenizer);

    expect(trace.stages[3]?.detail).toMatchObject({ includedUids: [2, 1] });
  });
});

describe('S5 历史裁剪与梗概（决议 D-01）', () => {
  it('超窗裁剪：取最近 N 条，梗概块替代被裁部分', () => {
    const messages = [msg(1, '最早的对话'), msg(2, '中间的对话'), msg(3, '最近的对话')];
    const trace = buildPrompt(
      makeInput({
        session: { ...settings, maxHistoryMessages: 2 },
        messages,
        synopsis: '此前：众人在码头集合。',
      }),
      tokenizer,
    );

    const user = trace.messages[1]?.content ?? '';
    expect(user).toContain('【剧情梗概】\n此前：众人在码头集合。');
    expect(user).not.toContain('最早的对话');
    expect(user).toContain('最近的对话');
    expect(trace.stages[4]?.detail).toMatchObject({
      total: 3,
      kept: 2,
      trimmed: 1,
      synopsisInjected: true,
    });
  });

  it('未超窗：不注入梗概（无被裁部分，D-01）', () => {
    const trace = buildPrompt(makeInput({ synopsis: '有梗概' }), tokenizer);

    expect(trace.messages[1]?.content).not.toContain('剧情梗概');
    expect(trace.stages[4]?.detail).toMatchObject({ synopsisInjected: false });
  });
});

describe('S6 position 插入（TC-FR-07-015）', () => {
  const input = makeInput({
    messages: [msg(1, '第一条'), msg(2, '第二条')],
    worldBook: {
      entries: [
        wbEntry({
          uid: 1,
          key: ['第一条'],
          content: '[before]',
          position: 'before_char',
          order: 0,
        }),
        wbEntry({ uid: 2, key: ['第一条'], content: '[after]', position: 'after_char', order: 0 }),
        wbEntry({
          uid: 3,
          key: ['第一条'],
          content: '[depth2]',
          position: 'at_depth',
          depth: 2,
          order: 0,
        }),
      ],
    },
  });

  it('三种 position 各归其位', () => {
    const trace = buildPrompt(input, tokenizer);

    const system = trace.messages[0]?.content ?? '';
    const user = trace.messages[1]?.content ?? '';
    expect(system.indexOf('[before]')).toBeLessThan(system.indexOf('你是守秘人'));
    expect(system.indexOf('[after]')).toBeGreaterThan(system.indexOf(META_INSTRUCTION));
    expect(system.indexOf('[after]')).toBeLessThan(system.indexOf('【状态板'));

    // depth=2、2 条历史：pos = 2-2 = 0 → 插在历史流最前（距底部 2 条消息的位置）
    const depthPos = user.indexOf('[depth2]');
    expect(depthPos).toBeLessThan(user.indexOf('[1][IC]'));
    expect(user.indexOf('[1][IC]')).toBeLessThan(user.indexOf('[2][IC]'));
  });

  it('at_depth depth=0 插在最末；同深多条按 order', () => {
    const input = makeInput({
      messages: [msg(1, '第一条')],
      worldBook: {
        entries: [
          wbEntry({
            uid: 1,
            key: ['第一条'],
            content: '[末尾A]',
            position: 'at_depth',
            depth: 0,
            order: 1,
          }),
          wbEntry({
            uid: 2,
            key: ['第一条'],
            content: '[末尾B]',
            position: 'at_depth',
            depth: 0,
            order: 0,
          }),
        ],
      },
    });
    const trace = buildPrompt(input, tokenizer);

    const user = trace.messages[1]?.content ?? '';
    expect(user.indexOf('[末尾B]')).toBeLessThan(user.indexOf('[末尾A]'));
    expect(user.indexOf('[末尾A]')).toBeGreaterThan(user.indexOf('[1][IC]'));
  });
});

describe('S7 硬顶回退（TC-FR-03-003）', () => {
  it('超硬顶：回退 S5 减半重裁至达标', () => {
    const messages = Array.from({ length: 8 }, (_, i) => msg(i + 1, `第${i + 1}条对话`));
    const input = makeInput({
      session: {
        ...settings,
        maxHistoryMessages: 8,
        contextWindowTokens: 600,
        outputReserveTokens: 200,
      },
      messages,
    });
    const trace = buildPrompt(input, tokenizer);

    const s7 = trace.stages[6]?.detail as {
      totalTokens: number;
      hardCap: number;
      overBudget: boolean;
      fallbackRounds: number;
      finalHistoryLength: number;
    };
    expect(s7.hardCap).toBe(400);
    expect(s7.totalTokens).toBeLessThanOrEqual(400);
    expect(s7.overBudget).toBe(false);
    expect(s7.fallbackRounds).toBeGreaterThan(0);
    expect(s7.finalHistoryLength).toBeLessThan(8);
  });

  it('历史裁空仍超限：overBudget 标记照发（不裁骨架）', () => {
    const input = makeInput({
      session: { ...settings, contextWindowTokens: 10, outputReserveTokens: 5 },
    });
    const trace = buildPrompt(input, tokenizer);

    const s7 = trace.stages[6]?.detail as { overBudget: boolean; fallbackRounds: number };
    expect(s7.overBudget).toBe(true);
    expect(s7.fallbackRounds).toBeGreaterThan(0);
  });

  it('未超限：零回退', () => {
    const trace = buildPrompt(makeInput(), tokenizer);

    expect(trace.stages[6]?.detail).toMatchObject({ overBudget: false, fallbackRounds: 0 });
  });
});
