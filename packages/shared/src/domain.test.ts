import { describe, expect, it } from 'vitest';
import {
  CharacterCardV3Schema,
  PCSheetSchema,
  RoomSchema,
  SessionSchema,
  StateBoardSchema,
} from './domain.js';

/**
 * T-M0-02：领域模型骨架（TDD §3.1 / §3.3 / §3.7）。
 * 这些 Schema 是存储层（§6）与 M1 房间/会话的落盘校验依据。
 */

const room = {
  id: 'room_abcdefgh',
  name: '深夜书房',
  createdAt: '2026-09-25T00:00:00.000Z',
  inviteCode: 'A1B2C3',
  activeSessionId: null,
  memberLimit: 8,
};

const sheet = {
  playerName: '张三',
  occupation: '记者',
  str: 50,
  con: 60,
  siz: 55,
  dex: 70,
  app: 45,
  int: 80,
  pow: 65,
  edu: 75,
  luck: 60,
  hp: 11,
  mp: 13,
  san: 65,
  db: '0',
  build: '0',
  skills: { 侦查: 60, 图书馆使用: 50 },
};

const session = {
  id: 'ses_1',
  roomId: room.id,
  moduleRef: 'module_demo@1.0.0',
  startedAt: '2026-09-25T00:00:00.000Z',
  endedAt: null,
  stateBoardVersion: 0,
  settings: {
    provider: 'openai-compat',
    model: 'deepseek-chat',
    temperature: 0.8,
    maxHistoryMessages: 40,
    worldBookBudgetTokens: 2000,
    scanDepth: 4,
  },
};

const stateBoard = {
  version: 1,
  pcs: { member_1: { sheet, conditions: ['重伤'] } },
  scene: { name: '书房', time: '1924-03-12 夜', publicDesc: '壁炉噼啪作响' },
  facts: ['门从内侧反锁'],
  updatedAt: '2026-09-25T00:00:00.000Z',
};

describe('RoomSchema（TDD §3.1）', () => {
  it('接受合法房间', () => {
    expect(RoomSchema.parse(room)).toMatchObject({ id: room.id, memberLimit: 8 });
  });

  it('邀请码必须是 6 位（§8：邀请码进房）', () => {
    expect(RoomSchema.safeParse({ ...room, inviteCode: 'A1B2C' }).success).toBe(false);
    expect(RoomSchema.safeParse({ ...room, inviteCode: 'A1B2C34' }).success).toBe(false);
  });

  it('缺少必填字段时拒绝', () => {
    for (const field of ['id', 'name', 'createdAt', 'inviteCode', 'memberLimit'] as const) {
      const { [field]: _omitted, ...rest } = room;
      expect(RoomSchema.safeParse(rest).success).toBe(false);
    }
  });

  it('activeSessionId 可为 null（未开团）', () => {
    expect(RoomSchema.safeParse({ ...room, activeSessionId: null }).success).toBe(true);
    expect(RoomSchema.safeParse({ ...room, activeSessionId: 'ses_1' }).success).toBe(true);
  });
});

describe('SessionSchema（TDD §3.1）', () => {
  it('接受合法会话', () => {
    expect(SessionSchema.parse(session)).toMatchObject({ id: 'ses_1', roomId: room.id });
  });

  it('settings 必须完整（管线依赖裁剪窗/预算/扫描深度）', () => {
    for (const field of [
      'provider',
      'model',
      'temperature',
      'maxHistoryMessages',
      'worldBookBudgetTokens',
      'scanDepth',
    ] as const) {
      const { [field]: _omitted, ...rest } = session.settings;
      expect(
        SessionSchema.safeParse({ ...session, settings: rest }).success,
        `缺少 settings.${field} 应被拒绝`,
      ).toBe(false);
    }
  });

  it('stateBoardVersion 为乐观锁版本号，不可为负', () => {
    expect(SessionSchema.safeParse({ ...session, stateBoardVersion: 0 }).success).toBe(true);
    expect(SessionSchema.safeParse({ ...session, stateBoardVersion: -1 }).success).toBe(false);
  });

  it('endedAt 可为 null（进行中的团）', () => {
    expect(SessionSchema.safeParse({ ...session, endedAt: null }).success).toBe(true);
  });
});

describe('StateBoardSchema（TDD §3.7）', () => {
  it('接受合法状态板', () => {
    const parsed = StateBoardSchema.parse(stateBoard);
    expect(parsed.version).toBe(1);
    expect(parsed.pcs['member_1']?.conditions).toEqual(['重伤']);
  });

  it('version 为乐观锁，不可为负（E-ST-01 依赖）', () => {
    expect(StateBoardSchema.safeParse({ ...stateBoard, version: -1 }).success).toBe(false);
  });

  it('pcs 条目必须携带 sheet（技能值以状态板为准）', () => {
    expect(
      StateBoardSchema.safeParse({ ...stateBoard, pcs: { member_1: { conditions: [] } } }).success,
    ).toBe(false);
  });

  it('scene 三字段齐全', () => {
    expect(
      StateBoardSchema.safeParse({
        ...stateBoard,
        scene: { name: '书房', time: '夜', publicDesc: '' },
      }).success,
    ).toBe(true);
    expect(
      StateBoardSchema.safeParse({ ...stateBoard, scene: { name: '书房', time: '夜' } }).success,
    ).toBe(false);
  });
});

describe('PCSheetSchema（TDD §3.3）', () => {
  it('接受合法调查员速览', () => {
    expect(PCSheetSchema.parse(sheet)).toMatchObject({ playerName: '张三', luck: 60 });
  });

  it('缺少 san / hp / mp 时拒绝（状态注入与理智扣除依赖）', () => {
    for (const field of ['hp', 'mp', 'san'] as const) {
      const { [field]: _omitted, ...rest } = sheet;
      expect(PCSheetSchema.safeParse(rest).success).toBe(false);
    }
  });

  it('skills 为技能名 → 数值的映射', () => {
    expect(
      PCSheetSchema.safeParse({ ...sheet, skills: { 侦查: '六十' } }).success,
      '技能值必须是数字，AI 只能传技能名',
    ).toBe(false);
  });
});

describe('CharacterCardV3Schema（TDD §3.3）', () => {
  const card = {
    spec: 'chara_card_v3',
    data: {
      name: '守秘人',
      description: '你是守秘人……',
      scenario: '深夜书房',
      first_mes: '灯亮了。',
      mes_example: '',
      extensions: { aidle: { rulebook: 'coc7' } },
    },
  };

  it('接受合法 ccv3 卡', () => {
    const parsed = CharacterCardV3Schema.parse(card);
    expect(parsed.spec).toBe('chara_card_v3');
  });

  it('spec 不符即拒绝（三步导入流的「检测」步骤依据）', () => {
    expect(CharacterCardV3Schema.safeParse({ ...card, spec: 'chara_card_v2' }).success).toBe(false);
  });

  it('data 必填字段缺失时拒绝', () => {
    for (const field of ['name', 'description', 'first_mes'] as const) {
      const { [field]: _omitted, ...rest } = card.data;
      expect(
        CharacterCardV3Schema.safeParse({ ...card, data: rest }).success,
        `缺少 data.${field} 应被拒绝`,
      ).toBe(false);
    }
  });

  it('extensions.aidle 可选（社区卡不一定带扩展）', () => {
    expect(
      CharacterCardV3Schema.safeParse({ ...card, data: { ...card.data, extensions: {} } }).success,
    ).toBe(true);
  });
});
