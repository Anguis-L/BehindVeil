import { describe, expect, it } from 'vitest';
import type { PipelineTracePayload, Session, SessionSettings } from '@behindveil/shared';
import {
  formatCostCny,
  formatHitKeywords,
  formatIsoShort,
  formatLatency,
  formatPercent,
  formatTokenCount,
  parseSettingsDraft,
  sessionStateLabel,
  summarizeTrace,
  type SettingsDraft,
  type WorldBookHitView,
} from './kp-console.js';

/**
 * T-M6-04/05：KP 控制台纯逻辑（trace 整理 / 格式化 / 参数校验）。
 * 不碰 DOM，只验输入输出。
 */

const settings: SessionSettings = {
  provider: 'openai-compat',
  model: 'deepseek-chat',
  temperature: 0.7,
  maxHistoryMessages: 40,
  worldBookBudgetTokens: 2000,
  scanDepth: 4,
  contextWindowTokens: 32_768,
  outputReserveTokens: 2_048,
};

const session: Session = {
  id: 'ses_1',
  roomId: 'room_1',
  moduleRef: 'mod-madness',
  startedAt: '2026-09-28T04:05:00.000Z',
  endedAt: null,
  stateBoardVersion: 0,
  settings,
  synopsis: '',
};

/** 与服务端 stages.ts 产出的 detail 形状一致 */
const trace: PipelineTracePayload = {
  stages: [
    { name: 'S1-skeleton', tokenCount: 120, detail: { sections: ['kp-persona'] } },
    {
      name: 'S3-worldbook-scan',
      tokenCount: 0,
      detail: {
        scannedMessageCount: 4,
        entryCount: 9,
        hitUids: [11, 12],
        hits: [
          {
            uid: 11,
            matchedKeys: ['剪报'],
            matchedSecondary: [],
            constant: false,
            kpOnly: true,
          },
          { uid: 12, matchedKeys: [], matchedSecondary: ['风声'], constant: false, kpOnly: false },
        ],
      },
    },
    {
      name: 'S4-budget-cut',
      tokenCount: 300,
      detail: { budgetTokens: 2000, includedUids: [11], droppedUids: [12], usedTokens: 300 },
    },
    {
      name: 'S5-history-trim',
      tokenCount: 500,
      detail: { total: 60, kept: 40, trimmed: 20, synopsisInjected: true },
    },
    { name: 'S6-assemble', tokenCount: 900, detail: { messageCount: 2 } },
    {
      name: 'S7-validate',
      tokenCount: 900,
      detail: { totalTokens: 900, hardCap: 30_720, overBudget: false, fallbackRounds: 0 },
    },
  ],
  messages: [
    { role: 'system', content: '你是守秘人' },
    { role: 'user', content: '【对话历史】\n…' },
  ],
};

describe('summarizeTrace（PipelineTrace → 界面视图）', () => {
  it('阶段带上中文短名与 token 数', () => {
    const summary = summarizeTrace(trace);
    expect(summary.stages.map((s) => s.label)).toEqual([
      '骨架（人格 + 规则速查）',
      '世界书扫描',
      '预算裁剪',
      '历史裁剪',
      '组装',
      '硬顶校验',
    ]);
    expect(summary.stages.map((s) => s.tokenCount)).toEqual([120, 0, 300, 500, 900, 900]);
  });

  it('命中条目带匹配关键词与被裁标记', () => {
    const summary = summarizeTrace(trace);
    expect(summary.hits).toEqual([
      {
        uid: 11,
        matchedKeys: ['剪报'],
        matchedSecondary: [],
        constant: false,
        kpOnly: true,
        included: true,
      },
      {
        uid: 12,
        matchedKeys: [],
        matchedSecondary: ['风声'],
        constant: false,
        kpOnly: false,
        included: false,
      },
    ]);
    expect(summary.budget.droppedUids).toEqual([12]);
    expect(summary.scan).toEqual({ scannedMessages: 4, entryCount: 9 });
  });

  it('总 token / 硬顶 / 回退轮次取自 S7', () => {
    const summary = summarizeTrace(trace);
    expect(summary.totalTokens).toBe(900);
    expect(summary.validate).toEqual({
      totalTokens: 900,
      hardCap: 30_720,
      overBudget: false,
      fallbackRounds: 0,
    });
    expect(summary.history).toEqual({ total: 60, kept: 40, trimmed: 20, synopsisInjected: true });
  });

  it('最终 messages 全文保留并附字数', () => {
    const summary = summarizeTrace(trace);
    expect(summary.messages).toEqual([
      { role: 'system', content: '你是守秘人', charCount: 5 },
      { role: 'user', content: '【对话历史】\n…', charCount: 8 },
    ]);
  });

  it('缺阶段 / detail 形状异常时退回默认，不崩', () => {
    const summary = summarizeTrace({ stages: [], messages: [] });
    expect(summary.stages).toEqual([]);
    expect(summary.hits).toEqual([]);
    expect(summary.validate.hardCap).toBeNull();
    expect(summary.totalTokens).toBe(0);
  });

  it('detail 是非对象（如字符串）时也退回默认', () => {
    const summary = summarizeTrace({
      stages: [{ name: 'S7-validate', tokenCount: 10, detail: 'unexpected' }],
      messages: [],
    });
    expect(summary.validate).toEqual({
      totalTokens: 0,
      hardCap: null,
      overBudget: false,
      fallbackRounds: 0,
    });
  });
});

describe('formatHitKeywords', () => {
  const base: WorldBookHitView = {
    uid: 1,
    matchedKeys: [],
    matchedSecondary: [],
    constant: false,
    kpOnly: false,
    included: true,
  };

  it('常驻条目优先', () => {
    expect(formatHitKeywords({ ...base, constant: true, matchedKeys: ['x'] })).toBe('常驻条目');
  });

  it('主关键词 + 二级关键词', () => {
    expect(
      formatHitKeywords({ ...base, matchedKeys: ['剪报', '报纸'], matchedSecondary: ['风声'] }),
    ).toBe('剪报、报纸（二级：风声）');
  });

  it('都没有时给空占位', () => {
    expect(formatHitKeywords(base)).toBe('');
  });
});

describe('数值格式化', () => {
  it('token 千分位', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(999)).toBe('999');
    expect(formatTokenCount(12_345)).toBe('12,345');
    expect(formatTokenCount(1_234_567)).toBe('1,234,567');
  });

  it('非有限值统一破折号', () => {
    expect(formatTokenCount(Number.NaN)).toBe('—');
    expect(formatCostCny(Number.NaN)).toBe('—');
    expect(formatPercent(Number.NaN)).toBe('—');
    expect(formatLatency(Number.NaN)).toBe('—');
  });

  it('成本：小额多给小数位', () => {
    expect(formatCostCny(0)).toBe('¥0');
    expect(formatCostCny(0.5)).toBe('¥0.5000');
    expect(formatCostCny(0.000_123)).toBe('¥0.000123');
    expect(formatCostCny(12.345)).toBe('¥12.35');
  });

  it('成功率与延迟', () => {
    expect(formatPercent(0)).toBe('0.0%');
    expect(formatPercent(0.833_333)).toBe('83.3%');
    expect(formatLatency(950)).toBe('950 ms');
    expect(formatLatency(1_500)).toBe('1.50 s');
  });
});

describe('会话展示', () => {
  it('进行中 / 已结束', () => {
    expect(sessionStateLabel(session)).toBe('进行中');
    expect(sessionStateLabel({ ...session, endedAt: '2026-09-28T06:00:00.000Z' })).toBe('已结束');
  });

  it('ISO 时间截到分钟', () => {
    expect(formatIsoShort('2026-09-28T04:05:00.000Z')).toBe('2026-09-28 04:05 UTC');
    expect(formatIsoShort('短')).toBe('短');
  });
});

describe('parseSettingsDraft（LLM 参数校验）', () => {
  const draft: SettingsDraft = {
    temperature: '0.8',
    maxHistoryMessages: '30',
    worldBookBudgetTokens: '1500',
    nat20Rule: 'attack_only',
  };

  it('合法且与当前值不同 → 进 patch', () => {
    expect(parseSettingsDraft(draft, settings)).toEqual({
      patch: { temperature: 0.8, maxHistoryMessages: 30, worldBookBudgetTokens: 1500 },
      errors: {},
      ok: true,
    });
  });

  it('与当前值相同 → patch 为空（不该发请求）', () => {
    const same: SettingsDraft = {
      temperature: '0.7',
      maxHistoryMessages: '40',
      worldBookBudgetTokens: '2000',
      nat20Rule: 'attack_only',
    };
    expect(parseSettingsDraft(same, settings).patch).toEqual({});
  });

  it('nat20Rule 改动单独进 patch（5e 房规开关）', () => {
    expect(parseSettingsDraft({ ...draft, nat20Rule: 'all_d20' }, settings).patch).toEqual({
      temperature: 0.8,
      maxHistoryMessages: 30,
      worldBookBudgetTokens: 1500,
      nat20Rule: 'all_d20',
    });
  });

  it('拿不到当前值时照发（current = null）', () => {
    expect(parseSettingsDraft(draft, null).patch).toEqual({
      temperature: 0.8,
      maxHistoryMessages: 30,
      worldBookBudgetTokens: 1500,
      nat20Rule: 'attack_only',
    });
  });

  it('temperature 越界 / 非数字', () => {
    expect(parseSettingsDraft({ ...draft, temperature: '2.5' }, settings).errors).toEqual({
      temperature: 'temperature 需在 0–2 之间',
    });
    expect(parseSettingsDraft({ ...draft, temperature: 'abc' }, settings).ok).toBe(false);
  });

  it('留空 = 不修改该项（空草稿不该满屏报错）', () => {
    const result = parseSettingsDraft(
      {
        temperature: '',
        maxHistoryMessages: '',
        worldBookBudgetTokens: '',
        nat20Rule: 'attack_only',
      },
      settings,
    );
    expect(result.errors).toEqual({});
    expect(result.patch).toEqual({});
  });

  it('temperature 边界 0 与 2 合法', () => {
    expect(parseSettingsDraft({ ...draft, temperature: '0' }, settings).ok).toBe(true);
    expect(parseSettingsDraft({ ...draft, temperature: '2' }, settings).ok).toBe(true);
  });

  it('裁剪窗必须是正整数', () => {
    expect(
      parseSettingsDraft({ ...draft, maxHistoryMessages: '0' }, settings).errors.maxHistoryMessages,
    ).toBe('裁剪窗必须是正整数');
    expect(
      parseSettingsDraft({ ...draft, maxHistoryMessages: '12.5' }, settings).errors
        .maxHistoryMessages,
    ).toBe('裁剪窗必须是正整数');
    expect(parseSettingsDraft({ ...draft, maxHistoryMessages: '1' }, settings).ok).toBe(true);
  });

  it('世界书预算必须是非负整数', () => {
    expect(
      parseSettingsDraft({ ...draft, worldBookBudgetTokens: '-1' }, settings).errors
        .worldBookBudgetTokens,
    ).toBe('世界书预算必须是非负整数');
    expect(parseSettingsDraft({ ...draft, worldBookBudgetTokens: '0' }, settings).ok).toBe(true);
  });

  it('非法字段不进 patch', () => {
    const bad = parseSettingsDraft({ ...draft, maxHistoryMessages: '-3' }, settings);
    expect(bad.patch).toEqual({ temperature: 0.8, worldBookBudgetTokens: 1500 });
    expect(bad.ok).toBe(false);
  });
});
