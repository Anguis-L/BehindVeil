import { describe, expect, it } from 'vitest';
import type { Member, Message, Session, WorldBook } from '@behindveil/shared';
import { renderHtml } from './html.js';
import { renderMarkdown } from './markdown.js';
import type { ExportInput } from './render.js';

/**
 * TC-FR-12-002：染色 HTML 导出——IC/OOC/骰子分类版式齐全，
 * **kpOnly 内容零出现**（TDD §8），消息内容一律转义（导出物会被浏览器直接打开）。
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
  id: 'ses_html001',
  roomId: 'room_html001',
  moduleRef: 'the-haunting',
  startedAt: '2026-09-25T20:00:00.000Z',
  endedAt: '2026-09-25T22:30:00.000Z',
  stateBoardVersion: 2,
  settings,
  synopsis: '',
};

const members: Member[] = [
  { id: 'm_alice', name: '爱丽丝', role: 'player', joinedAt: '2026-09-25T19:59:00.000Z' },
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
  skills: { 侦查: 60 },
};

const diceAudit = { seq: '000012', ts: '2026-09-25T20:00:04.000Z', rollId: 'roll-abc-123' };

const messages: Message[] = [
  {
    seq: 1,
    ts: '2026-09-25T20:00:01.000Z',
    sessionId: session.id,
    type: 'ic',
    senderId: 'm_alice',
    content: '<script>alert("xss")</script> 与 "引号" 与 & 符号',
  },
  {
    seq: 2,
    ts: '2026-09-25T20:00:02.000Z',
    sessionId: session.id,
    type: 'ooc',
    senderId: 'm_alice',
    content: '场外一句',
    visibility: 'host',
  },
  {
    seq: 3,
    ts: '2026-09-25T20:00:03.000Z',
    sessionId: session.id,
    type: 'narration',
    streaming: false,
    content: '走廊尽头有光。',
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
      },
      audit: diceAudit,
    },
    hidden: false,
    senderId: 'm_alice',
  },
  {
    seq: 5,
    ts: '2026-09-25T20:00:05.000Z',
    sessionId: session.id,
    type: 'system',
    subtype: 'join',
    content: '鲍勃 加入了房间',
  },
  {
    seq: 6,
    ts: '2026-09-25T20:00:06.000Z',
    sessionId: session.id,
    type: 'state_snapshot',
    stateBoard: {
      version: 2,
      pcs: { m_alice: { sheet, conditions: [] } },
      scene: { name: '阁楼', time: '深夜', publicDesc: '灰尘在光柱里浮动。' },
      facts: ['阁楼的箱子被撬过'],
      updatedAt: '2026-09-25T20:00:06.000Z',
    },
  },
];

const input: ExportInput = { roomName: '测试房', session, members, messages };

/** kpOnly 条目（模组真相）：只进 AI 上下文，任何导出产物都不得出现 */
const KP_ONLY_MARKER = 'KP_ONLY_SECRET_TRUTH_9527';
const worldBook: WorldBook = {
  entries: [
    {
      uid: 1,
      key: ['管家'],
      keysecondary: [],
      selectiveLogic: 0,
      content: `${KP_ONLY_MARKER}：凶手是管家`,
      position: 'before_char',
      order: 100,
      weight: 100,
      constant: true,
      disabled: false,
      extensions: { kpOnly: true },
    },
  ],
};

describe('TC-FR-12-002 染色 HTML 导出', () => {
  it('是自包含单文件：有文档骨架，无外部脚本与外链', () => {
    const html = renderHtml(input);
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
  });

  it('六类消息各自的版式 class 齐全', () => {
    const html = renderHtml(input);
    for (const cls of [
      'msg-ic',
      'msg-ooc',
      'msg-system',
      'msg-dice',
      'msg-narration',
      'msg-state_snapshot',
    ]) {
      expect(html).toContain(cls);
    }
  });

  it('骰子卡带判定语义色，审计行含流水号与 rollId', () => {
    const html = renderHtml(input);
    expect(html).toContain('--judge:#c79640'); // 普通成功
    expect(html).toContain('000012');
    expect(html).toContain('roll-abc-123');
    expect(html).toContain('1d100&lt;=60');
  });

  it('消息内容一律转义，注入串不会成为可执行标签', () => {
    const html = renderHtml(input);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&quot;引号&quot;');
    expect(html).toContain('&amp; 符号');
  });

  it('kpOnly 内容零出现（世界书不在导出输入里，此处为回归护栏）', () => {
    // worldBook 无法传给 renderHtml（ExportInput 类型上就不含它）——
    // 谁将来给导出接了世界书/prompt trace，下面两条断言会立刻变红。
    expect(worldBook.entries[0]?.content).toContain(KP_ONLY_MARKER);
    const html = renderHtml(input);
    expect(html).not.toContain(KP_ONLY_MARKER);
    expect(html).not.toContain('kpOnly');
    expect(renderMarkdown(input)).not.toContain(KP_ONLY_MARKER);
  });

  it('快照渲染为表格，已确立事实成清单', () => {
    const html = renderHtml(input);
    expect(html).toContain('<th>调查员</th>');
    expect(html).toContain('爱丽丝·陈');
    expect(html).toContain('<li>阁楼的箱子被撬过</li>');
  });

  it('仅 Host 可见的场外消息带标记，结束时间如实呈现', () => {
    const html = renderHtml(input);
    expect(html).toContain('仅 Host 可见');
    expect(html).toContain('2026-09-25T22:30:00.000Z');
  });

  it('空会话也产出可打开的完整文档', () => {
    const html = renderHtml({ ...input, messages: [] });
    expect(html).toContain('暂无消息');
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
  });
});
