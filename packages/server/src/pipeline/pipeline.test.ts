import { describe, expect, it } from 'vitest';
import { buildPrompt } from './index.js';
import type { PipelineInput } from './index.js';

/**
 * T-M0-07：管线骨架（TDD §5.1）。
 * M0 只验收骨架与 trace 可观测性：阶段齐全、纯函数、可序列化、tokenizer 走注入。
 * 各阶段的具体产物（S1 骨架文案 / S3 命中 / S5 裁剪）在 M2 由黄金用例验收（TC-NFR-09-002）。
 */

const input: PipelineInput = {
  session: {
    provider: 'openai-compat',
    model: 'deepseek-chat',
    temperature: 0.8,
    maxHistoryMessages: 40,
    worldBookBudgetTokens: 2000,
    scanDepth: 4,
  },
  kpCard: {
    spec: 'chara_card_v3',
    data: {
      name: '守秘人',
      description: '你是守秘人：叙事、扮演 NPC、只在必要时请求检定。',
      scenario: '深夜书房',
      first_mes: '灯亮了。',
      mes_example: '',
      extensions: {},
    },
  },
  messages: [
    {
      seq: 1,
      ts: '2026-09-25T00:00:00.000Z',
      sessionId: 'ses_1',
      type: 'ic',
      senderId: 'member_1',
      content: '我推开书房的门。',
    },
  ],
  stateBoard: {
    version: 1,
    pcs: {},
    scene: { name: '书房', time: '1924-03-12 夜', publicDesc: '壁炉噼啪作响' },
    facts: ['门从内侧反锁'],
    updatedAt: '2026-09-25T00:00:00.000Z',
  },
  worldBook: { entries: [] },
  pcRoster: '张三（记者）',
};

const tokenizer = { count: (text: string): number => text.length };

describe('buildPrompt 阶段骨架（TDD §5.1 S1–S7）', () => {
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

    expect(Array.isArray(trace.messages)).toBe(true);
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
});

describe('buildPrompt 边界', () => {
  it('空历史与空世界书不崩溃（刚开团）', () => {
    const empty: PipelineInput = { ...input, messages: [] };

    const trace = buildPrompt(empty, tokenizer);

    expect(trace.stages).toHaveLength(7);
    expect(Array.isArray(trace.messages)).toBe(true);
  });
});
