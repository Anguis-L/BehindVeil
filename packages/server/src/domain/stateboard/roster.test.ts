import { describe, expect, it } from 'vitest';
import type { StateBoard } from '@behindveil/shared';
import { createStateBoardRoster } from './roster.js';
import type { PcRoster } from '../ai-directive/executor.js';

/**
 * T-M5-04：真实 PC 名册（T-M3-03a 内存 stub 的结构化替换）。
 * 取值路径与 stub 同语义：命中携带展示名 / 查无人 / 查无技能；
 * 新增：playerName 回退（AI 指令块里可读的标识是名字，memberId 是 nanoid）、
 * 状态板未载入（undefined）兜底。
 */

const boardOf = (pcs: StateBoard['pcs']): StateBoard => ({
  version: 3,
  pcs,
  scene: { name: '', time: '', publicDesc: '' },
  facts: [],
  updatedAt: '1970-01-01T00:00:00.000Z',
});

const ALICE = {
  sheet: {
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
    skills: { 侦查: 60, 图书馆使用: 50 },
  },
  conditions: [],
};
const BOB = {
  sheet: {
    playerName: '鲍勃',
    occupation: '医生',
    str: 60,
    con: 65,
    siz: 60,
    dex: 50,
    app: 45,
    int: 70,
    pow: 60,
    edu: 75,
    luck: 50,
    hp: 12,
    mp: 12,
    san: 60,
    db: '1d4',
    build: '1',
    skills: { 聆听: 55, 急救: 50 },
  },
  conditions: ['轻伤'],
};

describe('createStateBoardRoster（T-M5-04）', () => {
  it('实现 PcRoster 端口', () => {
    const roster: PcRoster = createStateBoardRoster(boardOf({ m1: ALICE }));
    expect(roster.skillValue).toBeTypeOf('function');
  });

  it('memberId 精确命中：取状态板技能值并携带展示名', () => {
    expect(createStateBoardRoster(boardOf({ m1: ALICE })).skillValue('pc:m1', '侦查')).toEqual({
      found: true,
      value: 60,
      name: '爱丽丝',
    });
  });

  it('playerName 回退命中（AI 用叙事名取值）', () => {
    expect(createStateBoardRoster(boardOf({ m1: ALICE })).skillValue('pc:爱丽丝', '侦查')).toEqual({
      found: true,
      value: 60,
      name: '爱丽丝',
    });
  });

  it('memberId 优先于同名 PC 名', () => {
    const roster = createStateBoardRoster(
      boardOf({
        m1: ALICE,
        m2: { sheet: { ...ALICE.sheet, skills: { 侦查: 35 } }, conditions: [] },
      }),
    );
    expect(roster.skillValue('pc:m2', '侦查')).toMatchObject({ value: 35 });
  });

  it('多 PC 各自按 playerName 命中，互不串值', () => {
    const roster = createStateBoardRoster(boardOf({ m1: ALICE, m2: BOB }));
    expect(roster.skillValue('pc:鲍勃', '聆听')).toMatchObject({ found: true, value: 55 });
    expect(roster.skillValue('pc:爱丽丝', '聆听')).toEqual({
      found: false,
      reason: 'skill-not-found',
    });
  });

  it.each([
    ['不存在的 PC', 'pc:carol', '侦查'],
    ['无 pc: 前缀的目标', '爱丽丝', '侦查'],
  ])('%s → pc-not-found', (_name, target, skill) => {
    expect(createStateBoardRoster(boardOf({ m1: ALICE })).skillValue(target, skill)).toEqual({
      found: false,
      reason: 'pc-not-found',
    });
  });

  it('存在的 PC 无此技能 → skill-not-found（数值仍不出自 AI）', () => {
    expect(createStateBoardRoster(boardOf({ m1: ALICE })).skillValue('pc:m1', '攀爬')).toEqual({
      found: false,
      reason: 'skill-not-found',
    });
  });

  it('状态板未载入（undefined）→ 一律 pc-not-found，不抛错', () => {
    expect(createStateBoardRoster(undefined).skillValue('pc:m1', '侦查')).toEqual({
      found: false,
      reason: 'pc-not-found',
    });
  });
});
