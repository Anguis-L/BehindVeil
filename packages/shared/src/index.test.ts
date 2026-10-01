import { describe, expect, it } from 'vitest';
import {
  APP_NAME,
  MESSAGE_TYPES,
  PCSheetSchema,
  PROTOCOL_VERSION,
  StateBoardSchema,
} from './index.js';
import type { MessageType } from './index.js';

describe('shared contract placeholders', () => {
  it('exposes a stable app name', () => {
    expect(APP_NAME).toBe('BehindVeil');
  });

  it('exposes a semver-shaped protocol version', () => {
    expect(PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('defines exactly the six message types from TDD §3.2', () => {
    expect(MESSAGE_TYPES).toEqual(['ic', 'ooc', 'system', 'dice', 'narration', 'state_snapshot']);
  });

  it('keeps the runtime constant and the type in sync', () => {
    const all: MessageType[] = [...MESSAGE_TYPES];
    expect(new Set(all).size).toBe(MESSAGE_TYPES.length);
  });
});

// ---- PCSheet 判别联合旧数据兼容（T-M8-01 / G-M8 门禁第一项）----

describe('PCSheet 判别联合旧数据兼容（T-M8-01，设计 §5.3）', () => {
  const v1CocSheet = {
    playerName: '爱丽丝',
    occupation: '记者',
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
    skills: { 侦查: 60 },
  };

  it('v1 存量 sheet（无 rulebook 字段）→ default 补 coc7，零迁移可解析', () => {
    const parsed = PCSheetSchema.parse(v1CocSheet);
    expect(parsed.rulebook).toBe('coc7');
    if (parsed.rulebook === 'coc7') expect(parsed.san).toBe(55);
  });

  it('v1 存量 state.json（板内 pcs 的 sheet 无 rulebook）→ 整板解析成功', () => {
    const v1Board = {
      version: 3,
      pcs: { m1: { sheet: v1CocSheet, conditions: ['轻伤'] } },
      scene: { name: '书房', time: '', publicDesc: '' },
      facts: [],
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const board = StateBoardSchema.parse(v1Board);
    expect(board.pcs.m1?.sheet.rulebook).toBe('coc7');
  });

  it('5e 卡带 rulebook=dnd5e → 走 dnd5e 分支；缺字段 → 报错（不静默吞）', () => {
    const parsed = PCSheetSchema.parse({
      rulebook: 'dnd5e',
      playerName: '艾恩',
      occupation: '游荡者',
      abilities: { str: 10, dex: 16, con: 12, int: 13, wis: 16, cha: 8 },
      proficiencyBonus: 2,
      ac: 15,
      hp: { max: 22, current: 22 },
    });
    expect(parsed.rulebook).toBe('dnd5e');
    if (parsed.rulebook === 'dnd5e') {
      // proficientSkills / proficientSaves 缺省空数组；occupation 缺省空串
      expect(parsed.proficientSkills).toEqual([]);
      expect(parsed.proficientSaves).toEqual([]);
    }
    expect(() => PCSheetSchema.parse({ ...v1CocSheet, rulebook: 'dnd5e' })).toThrow();
  });
});
