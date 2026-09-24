import { describe, expect, it } from 'vitest';
import {
  DiceMsgSchema,
  IcMsgSchema,
  MessageSchema,
  NarrationMsgSchema,
  OocMsgSchema,
  SnapshotMsgSchema,
  SystemMsgSchema,
} from './message.js';

/**
 * T-M0-02「契约先行」：消息类型系统（TDD §3.2 六类）。
 * 这些用例同时是前后端共享契约的验收基准：任何字段调整都必须先改这里。
 */

const base = { seq: 7, ts: '2026-09-25T00:00:00.000Z', sessionId: 'ses_1' };

const roll = {
  expr: '1d100',
  rolls: [[42]],
  kept: [42],
  total: 42,
  check: {
    rulebook: 'coc7' as const,
    kind: 'skill' as const,
    target: 60,
    difficulty: 'normal' as const,
    outcome: 'success' as const,
  },
  audit: { seq: '7', ts: '2026-09-25T00:00:00.000Z', rollId: 'roll_01' },
};

const stateBoard = {
  version: 3,
  pcs: {},
  scene: { name: '书房', time: '1924-03-12 夜', publicDesc: '壁炉噼啪作响' },
  facts: ['门从内侧反锁'],
  updatedAt: '2026-09-25T00:00:00.000Z',
};

describe('BaseMsg 公共字段（TDD §3.2）', () => {
  it('六类消息都必须带 seq / ts / sessionId', () => {
    for (const type of ['ic', 'ooc', 'system', 'dice', 'narration', 'state_snapshot'] as const) {
      expect(MessageSchema.safeParse({ type }).success).toBe(false);
    }
  });

  it('seq 必须是非负整数', () => {
    const ok = IcMsgSchema.safeParse({
      ...base,
      seq: 0,
      type: 'ic',
      senderId: 'm1',
      content: 'hi',
    });
    expect(ok.success).toBe(true);

    for (const seq of [-1, 1.5, '7']) {
      const bad = IcMsgSchema.safeParse({
        ...base,
        seq,
        type: 'ic',
        senderId: 'm1',
        content: 'hi',
      });
      expect(bad.success).toBe(false);
    }
  });
});

describe('IcMsg', () => {
  it('接受合法 IC 消息并保留字段', () => {
    const parsed = IcMsgSchema.parse({
      ...base,
      type: 'ic',
      senderId: 'member_1',
      content: '我推开书房的门。',
    });
    expect(parsed).toMatchObject({ type: 'ic', senderId: 'member_1', content: '我推开书房的门。' });
  });

  it('缺少 senderId 或 content 时拒绝', () => {
    expect(IcMsgSchema.safeParse({ ...base, type: 'ic', content: 'x' }).success).toBe(false);
    expect(IcMsgSchema.safeParse({ ...base, type: 'ic', senderId: 'm1' }).success).toBe(false);
  });
});

describe('OocMsg', () => {
  it('visibility 取 all / host / whisper', () => {
    expect(
      OocMsgSchema.safeParse({
        ...base,
        type: 'ooc',
        senderId: 'm1',
        content: 'x',
        visibility: 'all',
      }).success,
    ).toBe(true);
    expect(
      OocMsgSchema.safeParse({
        ...base,
        type: 'ooc',
        senderId: 'm1',
        content: 'x',
        visibility: 'host',
      }).success,
    ).toBe(true);
    expect(
      OocMsgSchema.safeParse({
        ...base,
        type: 'ooc',
        senderId: 'm1',
        content: 'x',
        visibility: 'whisper',
        targetId: 'm2',
      }).success,
    ).toBe(true);
  });

  it('非法 visibility 被拒绝（防伪造可见性）', () => {
    expect(
      OocMsgSchema.safeParse({
        ...base,
        type: 'ooc',
        senderId: 'm1',
        content: 'x',
        visibility: 'kp',
      }).success,
    ).toBe(false);
  });

  it('whisper 允许携带 targetId', () => {
    const parsed = OocMsgSchema.parse({
      ...base,
      type: 'ooc',
      senderId: 'm1',
      content: '悄悄话',
      visibility: 'whisper',
      targetId: 'member_2',
    });
    expect(parsed).toMatchObject({ visibility: 'whisper', targetId: 'member_2' });
  });
});

describe('SystemMsg', () => {
  it('subtype 限定四类', () => {
    for (const subtype of ['ai_directive_result', 'join', 'leave', 'notice'] as const) {
      expect(
        SystemMsgSchema.safeParse({ ...base, type: 'system', subtype, content: 'x' }).success,
      ).toBe(true);
    }
  });

  it('未知 subtype 被拒绝（AI 指令回注只走 ai_directive_result）', () => {
    expect(
      SystemMsgSchema.safeParse({ ...base, type: 'system', subtype: 'dice_result', content: 'x' })
        .success,
    ).toBe(false);
  });
});

describe('DiceMsg', () => {
  it('接受完整 RollResult（含 check 与审计字段）', () => {
    const parsed = DiceMsgSchema.parse({ ...base, type: 'dice', roll, hidden: false });
    expect(parsed).toMatchObject({ type: 'dice', hidden: false });
    expect(parsed.roll.total).toBe(42);
  });

  it('缺少 roll 被拒绝（掷骰结果不可为空）', () => {
    expect(DiceMsgSchema.safeParse({ ...base, type: 'dice', hidden: false }).success).toBe(false);
  });

  it('hidden 标记暗骰（FR-14）', () => {
    const parsed = DiceMsgSchema.parse({ ...base, type: 'dice', roll, hidden: true });
    expect(parsed.hidden).toBe(true);
  });
});

describe('NarrationMsg', () => {
  it('streaming 标记流式状态', () => {
    const parsed = NarrationMsgSchema.parse({
      ...base,
      type: 'narration',
      streaming: true,
      content: '你听见……',
    });
    expect(parsed).toMatchObject({ streaming: true, content: '你听见……' });
  });

  it('缺少 streaming 被拒绝', () => {
    expect(NarrationMsgSchema.safeParse({ ...base, type: 'narration', content: 'x' }).success).toBe(
      false,
    );
  });
});

describe('SnapshotMsg', () => {
  it('携带状态板快照', () => {
    const parsed = SnapshotMsgSchema.parse({ ...base, type: 'state_snapshot', stateBoard });
    expect(parsed.stateBoard.version).toBe(3);
  });

  it('缺少 stateBoard 被拒绝', () => {
    expect(SnapshotMsgSchema.safeParse({ ...base, type: 'state_snapshot' }).success).toBe(false);
  });
});

describe('MessageSchema 判别联合', () => {
  it('按 type 分派到正确的子类型', () => {
    const ic = MessageSchema.parse({ ...base, type: 'ic', senderId: 'm1', content: 'hi' });
    expect(ic.type).toBe('ic');

    const dice = MessageSchema.parse({ ...base, type: 'dice', roll, hidden: false });
    expect(dice.type).toBe('dice');
  });

  it('未知 type 与缺失 type 均被拒绝（Socket 入站校验依赖此行为）', () => {
    expect(MessageSchema.safeParse({ ...base, type: 'emote', content: 'x' }).success).toBe(false);
    expect(MessageSchema.safeParse({ ...base, content: 'x' }).success).toBe(false);
  });

  it('type 与实际字段不匹配时拒绝（防止 ic 载荷伪装成 dice）', () => {
    expect(
      MessageSchema.safeParse({ ...base, type: 'dice', hidden: false, content: 'nope' }).success,
    ).toBe(false);
  });
});
