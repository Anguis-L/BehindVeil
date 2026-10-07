import { describe, expect, it } from 'vitest';
import { buildPrompt, META_INSTRUCTION } from './index.js';
import type { PipelineInput } from './index.js';
import { createHeuristicTokenizer } from './tokenizer.js';

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
              rulebook: 'coc7',
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
            conditions: [{ label: '疯狂(临时)' }],
            resources: [],
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

describe('kpOnly 条目（TC-FR-07-011）', () => {
  it('kpOnly 恒注入 prompt 且 trace 可见（模组真相：AI 知道但不应说）', () => {
    const input = makeInput({
      messages: [msg(1, '与关键词无关的文本')],
      worldBook: {
        entries: [
          wbEntry({
            uid: 7,
            key: [],
            content: '【模组真相】雕像后方有暗门。',
            extensions: { kpOnly: true },
          }),
        ],
      },
    });
    const trace = buildPrompt(input, tokenizer);

    expect(trace.messages[0]?.content).toContain('【模组真相】雕像后方有暗门。');
    expect(trace.stages[2]?.detail).toMatchObject({
      hits: [{ uid: 7, matchedKeys: [], constant: false, kpOnly: true }],
    });
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

describe('全 prompt / S2 块 token 预算（G-M12 账户，T-M12-04）', () => {
  /**
   * 设计文档 v3 §5.1 账户（2026-10-07 已拍板改口径）：「先攻/资源/conditions 注入后
   * **全 prompt** 每轮增量 ≤15%（相对 v2.0 同 fixture）」。
   *
   * 口径依据（施工文档 v3 §6 变更日志 2026-10-07 条）：原账户按 S2 块口径实测
   * coc7 +38.7% / 5e +63.3%——先攻行 + 资源段的信息量本身即超顶，「超顶先砍注入
   * 文案」在此口径下等于删功能，物理不可达；全 prompt 口径下 15% 是紧但可达的
   * 每轮上下文保护顶。本用例同时钉住两个实测值：
   *   - 全 prompt 增量 ≤ 15%（设计硬顶，守护每轮上下文账户）；
   *   - S2 块增量 ≤ 实测基线（防未来注入口径悄悄膨胀——超钉值先砍注入文案格式）。
   *
   * 夹具：中期团一轮（满 40 条历史 + 5 PC + 5 事实 + 场景）。v2.0 基线 = 同板去
   * M12 字段：conditions 仅 label（与 v2.0 字符串注入逐字节等价）、无资源、无先攻；
   * M12 增量 = note 括注 + 资源段 + 先攻行。tokenizer 用仓内 heuristic 实现。
   */
  const heuristic = createHeuristicTokenizer();

  const coc7Sheet = (name: string, occupation: string) => ({
    rulebook: 'coc7' as const,
    playerName: name,
    occupation,
    str: 50,
    con: 60,
    siz: 55,
    dex: 70,
    app: 50,
    int: 75,
    pow: 55,
    edu: 80,
    luck: 40,
    hp: 11,
    mp: 11,
    san: 55,
    db: '0',
    build: '0',
    skills: { 侦查: 60, 图书馆使用: 50 },
  });
  const dnd5eSheet = (name: string, occupation: string) => ({
    rulebook: 'dnd5e' as const,
    playerName: name,
    occupation,
    abilities: { str: 10, dex: 16, con: 12, int: 13, wis: 16, cha: 8 },
    proficiencyBonus: 2,
    ac: 15,
    hp: { max: 22, current: 17 },
    proficientSkills: ['察觉'],
    proficientSaves: ['dex', 'int'] as Array<'dex' | 'int'>,
  });

  /** v2.0 时代 conditions 以裸字符串注入；仅 label 的对象与其逐字节等价 */
  const M12_CONDITIONS = [
    {
      base: ['轻伤', '恐惧(临时)'],
      m12: [{ label: '轻伤' }, { label: '恐惧(临时)', note: '见血触发' }],
    },
    { base: ['中毒'], m12: [{ label: '中毒' }] },
    { base: ['背伤'], m12: [{ label: '背伤', note: '阴雨天加重' }] },
    { base: [] as string[], m12: [] },
    { base: ['疲惫'], m12: [{ label: '疲惫' }] },
  ];

  const budgetBoard = (rulebook: 'coc7' | 'dnd5e', withM12: boolean) => {
    const party: Array<[string, string]> =
      rulebook === 'coc7'
        ? [
            ['张三', '记者'],
            ['阿珂', '侦探'],
            ['富兰克林', '医生'],
            ['露娜', '古董商'],
            ['老赵', '流浪汉'],
          ]
        : [
            ['艾恩', '游荡者'],
            ['索拉娜', '法师'],
            ['布鲁诺', '战士'],
            ['薇拉', '牧师'],
            ['皮克', '游侠'],
          ];
    const pcs: PipelineInput['stateBoard']['pcs'] = {};
    party.forEach(([name, occupation], i) => {
      pcs[`m${i + 1}`] = {
        sheet: rulebook === 'coc7' ? coc7Sheet(name, occupation) : dnd5eSheet(name, occupation),
        conditions: withM12
          ? M12_CONDITIONS[i]!.m12
          : M12_CONDITIONS[i]!.base.map((label) => ({ label })),
        resources: withM12
          ? rulebook === 'coc7'
            ? [{ name: '绑扎带', current: 2, max: 3, resetOn: 'none' as const }]
            : [
                { name: '一环法术位', current: 2, max: 3, resetOn: 'long_rest' as const },
                { name: '箭矢', current: 12, max: 20, resetOn: 'none' as const },
              ]
          : [],
      };
    });
    const scene: PipelineInput['stateBoard']['scene'] = {
      name: '旧宅门厅',
      time: '1928 年秋夜',
      publicDesc: '抓痕延伸向二楼，楼梯在尽头拐角。',
    };
    if (withM12) {
      scene.initiative = {
        order: party
          .map(([label], i) => ({ ref: `pc:m${i + 1}`, label, roll: 20 - i * 2 }))
          .concat([{ ref: 'npc:哥布林', label: '哥布林', roll: 5 }]),
        currentIdx: 2,
        round: 3,
      };
    }
    return {
      version: 7,
      pcs,
      scene,
      facts: [
        '门从内侧反锁',
        '桌上有未拆的信',
        '壁炉的灰是冷的',
        '楼梯上有新鲜抓痕',
        '二楼传来木地板吱呀声',
      ],
      updatedAt: '2026-10-01T00:00:00.000Z',
    } as PipelineInput['stateBoard'];
  };

  const DIALOG = [
    '我举起提灯走进门厅。',
    '灰尘在灯光里浮动，你踩上第一级楼梯。',
    '我按住剑柄，警惕四周。',
    '楼梯的扶手上有一道新鲜的抓痕。',
    '我检查抓痕的高度。',
    '大约到成年人的胸口，爪距很宽。',
    '我们继续上楼吗？',
    '守秘人：先让我确认一件事。',
    '我环顾四周寻找光源。',
    '壁炉的灰是冷的，这里至少三天没人来过。',
  ];
  const history = Array.from({ length: 40 }, (_, i) => msg(i + 1, DIALOG[i % DIALOG.length]!));

  const measure = (rulebook: 'coc7' | 'dnd5e', withM12: boolean) => {
    const trace = buildPrompt(
      makeInput({
        messages: history,
        stateBoard: budgetBoard(rulebook, withM12),
        pcRoster: '张三（记者）、阿珂（侦探）、富兰克林（医生）、露娜（古董商）、老赵（流浪汉）',
      }),
      heuristic,
    );
    const s2 = trace.stages.find((stage) => stage.name.startsWith('S2'))?.tokenCount ?? 0;
    const total = trace.stages.find((stage) => stage.name.startsWith('S7'))?.tokenCount ?? 0;
    return { s2, total };
  };

  it('全 prompt 增量 ≤15%（设计硬顶；coc7 与 5e 两套 5 人团对照）', () => {
    for (const rulebook of ['coc7', 'dnd5e'] as const) {
      const before = measure(rulebook, false);
      const after = measure(rulebook, true);
      const ratio = (after.total - before.total) / before.total;
      expect(
        ratio,
        `${rulebook} 全 prompt 增量 ${(ratio * 100).toFixed(1)}%（${before.total} → ${after.total}）`,
      ).toBeLessThanOrEqual(0.15);
    }
  });

  it('S2 块增量不越过实测基线（回归膨胀闸；2026-10-07 实测 coc7 +38.7%、5e +63.3%）', () => {
    for (const [rulebook, pin] of [
      ['coc7', 0.42],
      ['dnd5e', 0.68],
    ] as const) {
      const before = measure(rulebook, false);
      const after = measure(rulebook, true);
      const ratio = (after.s2 - before.s2) / before.s2;
      expect(
        ratio,
        `${rulebook} S2 块增量 ${(ratio * 100).toFixed(1)}%（${before.s2} → ${after.s2}）超过实测基线钉值 ${pin}`,
      ).toBeLessThanOrEqual(pin);
    }
  });
});
