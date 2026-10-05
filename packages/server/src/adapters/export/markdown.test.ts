import { describe, expect, it } from 'vitest';
import type { Member, Message, Session } from '@behindveil/shared';
import { renderMarkdown } from './markdown.js';
import { judgeLevelOf, outcomeTextOf, toExportEntries } from './render.js';
import type { ExportInput } from './render.js';

/**
 * TC-FR-12-001：Markdown 导出——六类消息齐全，骰子记录含审计信息
 * （expr / rolls / total / 判定 / 流水号；另含 rollId 便于与审计流水对账）。
 */

const settings = {
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
  id: 'ses_test0001',
  roomId: 'room_test0001',
  moduleRef: 'the-haunting',
  startedAt: '2026-09-25T20:00:00.000Z',
  endedAt: null,
  stateBoardVersion: 1,
  settings,
  synopsis: '一行梗概',
};

const members: Member[] = [
  { id: 'm_alice', name: '爱丽丝', role: 'player', joinedAt: '2026-09-25T19:59:00.000Z' },
  { id: 'm_bob', name: '鲍勃', role: 'player', joinedAt: '2026-09-25T19:59:30.000Z' },
];

const sheet = {
  rulebook: 'coc7' as const,
  playerName: '爱丽丝·陈',
  occupation: '记者',
  str: 50,
  con: 60,
  siz: 55,
  dex: 70,
  app: 65,
  int: 80,
  pow: 75,
  edu: 70,
  luck: 50,
  hp: 11,
  mp: 15,
  san: 65,
  db: '0',
  build: '0',
  skills: { 侦查: 60, 图书馆使用: 50 },
};

/** 六类消息各一条，外加暗骰与密语两条边界形态 */
const messages: Message[] = [
  {
    seq: 1,
    ts: '2026-09-25T20:00:01.000Z',
    sessionId: session.id,
    type: 'ic',
    senderId: 'm_alice',
    content: '我推开那扇门。',
  },
  {
    seq: 2,
    ts: '2026-09-25T20:00:02.000Z',
    sessionId: session.id,
    type: 'ooc',
    senderId: 'm_alice',
    content: '这句是场外。',
    visibility: 'whisper',
    targetId: 'm_bob',
  },
  {
    seq: 3,
    ts: '2026-09-25T20:00:03.000Z',
    sessionId: session.id,
    type: 'narration',
    streaming: false,
    content: '门后是一条漆黑的走廊。',
  },
  {
    seq: 4,
    ts: '2026-09-25T20:00:04.000Z',
    sessionId: session.id,
    type: 'dice',
    roll: {
      expr: '1d100<=60',
      rolls: [[45]],
      kept: [45],
      total: 45,
      check: {
        rulebook: 'coc7',
        kind: 'skill',
        target: 60,
        difficulty: 'normal',
        outcome: 'success',
        grade: 'normal',
      },
      audit: { seq: '000012', ts: '2026-09-25T20:00:04.000Z', rollId: 'roll-abc-123' },
    },
    hidden: false,
    senderId: 'm_alice',
  },
  {
    seq: 5,
    ts: '2026-09-25T20:00:05.000Z',
    sessionId: session.id,
    type: 'system',
    subtype: 'ai_directive_result',
    content: '侦查检定：成功',
  },
  {
    seq: 6,
    ts: '2026-09-25T20:00:06.000Z',
    sessionId: session.id,
    type: 'dice',
    roll: {
      expr: '1d100',
      rolls: [[98]],
      kept: [98],
      total: 98,
      check: {
        rulebook: 'coc7',
        kind: 'sanity',
        target: 65,
        difficulty: 'hard',
        outcome: 'fumble',
      },
      audit: { seq: '000013', ts: '2026-09-25T20:00:06.000Z', rollId: 'roll-def-456' },
    },
    hidden: true,
  },
  {
    seq: 7,
    ts: '2026-09-25T20:00:07.000Z',
    sessionId: session.id,
    type: 'state_snapshot',
    stateBoard: {
      version: 1,
      pcs: { m_alice: { sheet, conditions: [{ label: '轻伤' }], resources: [] } },
      scene: { name: '走廊', time: '深夜 23:40', publicDesc: '两侧墙纸剥落。' },
      facts: ['门是从里面锁上的'],
      updatedAt: '2026-09-25T20:00:07.000Z',
    },
  },
];

const input: ExportInput = { roomName: '测试房', session, members, messages };

describe('TC-FR-12-001 Markdown 导出', () => {
  it('六类消息齐全，分类标签各自出现', () => {
    const md = renderMarkdown(input);
    for (const label of ['扮演', '场外', '叙事', '骰子', '系统', '状态快照']) {
      expect(md).toContain(label);
    }
    expect(md).toContain('我推开那扇门。');
    expect(md).toContain('门后是一条漆黑的走廊。');
  });

  it('骰子记录含审计五要素与 rollId', () => {
    const md = renderMarkdown(input);
    expect(md).toContain('`1d100<=60`');
    expect(md).toContain('[45]');
    expect(md).toContain('**45**');
    expect(md).toContain('普通成功');
    expect(md).toContain('`000012`');
    expect(md).toContain('roll-abc-123');
  });

  it('暗骰与密语照实导出并打标记（Host 视角完整版）', () => {
    const md = renderMarkdown(input);
    expect(md).toContain('暗骰');
    expect(md).toContain('密语→鲍勃');
  });

  it('状态快照渲染为表格与事实清单', () => {
    const md = renderMarkdown(input);
    expect(md).toContain('| 爱丽丝·陈 | 爱丽丝 | 11 | 65 | 15 | 50 | 轻伤 |');
    expect(md).toContain('- 门是从里面锁上的');
    expect(md).toContain('走廊');
  });

  it('未结束会话标注进行中，梗概照带', () => {
    const md = renderMarkdown(input);
    expect(md).toContain('（进行中）');
    expect(md).toContain('剧情梗概');
    expect(md).toContain('一行梗概');
  });

  it('按 seq 升序输出（输入乱序也不乱）', () => {
    const shuffled = [...messages].reverse();
    const md = renderMarkdown({ ...input, messages: shuffled });
    const positions = [1, 2, 3, 4, 5, 6, 7].map((seq) => md.indexOf(`[${seq}]`));
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i]!).toBeGreaterThan(positions[i - 1]!);
    }
  });

  it('成员缺失时说话人回退为 memberId', () => {
    const md = renderMarkdown({ ...input, members: [] });
    expect(md).toContain('m_alice');
    expect(md).not.toContain('爱丽丝 · 扮演');
  });

  it('空会话给出明确提示而不是空文件', () => {
    const md = renderMarkdown({ ...input, messages: [] });
    expect(md).toContain('暂无消息');
    expect(md).toContain('消息数');
  });

  it('引擎代掷的骰子署名为 KP', () => {
    const entries = toExportEntries(input);
    const engineRolled = entries.find((e) => e.seq === 6);
    expect(engineRolled?.speaker).toBe('KP');
  });
});

describe('判定等级推导', () => {
  const base = {
    rulebook: 'coc7' as const,
    kind: 'skill' as const,
    target: 50,
    difficulty: 'normal' as const,
  };

  it('六档 outcome/grade 组合映射正确', () => {
    expect(judgeLevelOf({ ...base, outcome: 'critical' })).toBe('critical');
    expect(judgeLevelOf({ ...base, outcome: 'success', grade: 'extreme' })).toBe('extreme');
    expect(judgeLevelOf({ ...base, outcome: 'success', grade: 'hard' })).toBe('hard');
    expect(judgeLevelOf({ ...base, outcome: 'success' })).toBe('regular');
    expect(judgeLevelOf({ ...base, outcome: 'fail' })).toBe('fail');
    expect(judgeLevelOf({ ...base, outcome: 'fumble' })).toBe('fumble');
    expect(judgeLevelOf(undefined)).toBe('none');
  });

  it('判定文案与档位一致', () => {
    expect(outcomeTextOf({ ...base, outcome: 'critical' })).toBe('大成功');
    expect(outcomeTextOf({ ...base, outcome: 'success', grade: 'extreme' })).toBe('极难成功');
    expect(outcomeTextOf({ ...base, outcome: 'success', grade: 'hard' })).toBe('困难成功');
    expect(outcomeTextOf({ ...base, outcome: 'success' })).toBe('普通成功');
    expect(outcomeTextOf({ ...base, outcome: 'fail' })).toBe('失败');
    expect(outcomeTextOf({ ...base, outcome: 'fumble' })).toBe('大失败');
    expect(outcomeTextOf(undefined)).toBe('—');
  });
});
