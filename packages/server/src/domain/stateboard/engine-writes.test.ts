import { describe, expect, it } from 'vitest';
import type { StateBoard } from '@behindveil/shared';
import type { ParsedRoll } from '../dice/evaluator.js';
import { Coc7RuleBook } from '../rulebook/coc7.js';
import type { RuleBook } from '../rulebook/types.js';
import { hpPatch, resourcePatch, sanityLossPatch } from './engine-writes.js';
import { applyStatePatch } from './board.js';

/**
 * T-M5-08：引擎写路径示例——COC7 sanityRule 理智扣除 → state patch（FR-05/09）。
 * 数值由规则引擎产生（损失骰为服务端预掷结果），LLM 不介入；
 * patch 经 applyStatePatch 走与 Host 相同的乐观锁写路径（TC-FR-09-003 引擎路径可写）。
 */

const ALICE_SAN = 55;

const board = (san = ALICE_SAN): StateBoard => ({
  version: 4,
  pcs: {
    m1: {
      sheet: {
        rulebook: 'coc7',
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
        san,
        db: '0',
        build: '0',
        skills: { 侦查: 60 },
      },
      conditions: [],
      resources: [],
    },
  },
  scene: { name: '', time: '', publicDesc: '' },
  facts: [],
  updatedAt: '1970-01-01T00:00:00.000Z',
});

/** 5e 板（T-M8-03）：艾恩 22/22 HP */
const board5e = (current = 22, max = 22): StateBoard => ({
  version: 4,
  pcs: {
    m1: {
      sheet: {
        rulebook: 'dnd5e',
        playerName: '艾恩',
        occupation: '游荡者',
        abilities: { str: 10, dex: 16, con: 12, int: 13, wis: 16, cha: 8 },
        proficiencyBonus: 2,
        ac: 15,
        hp: { max, current },
        proficientSkills: ['察觉'],
        proficientSaves: ['dex', 'int'],
      },
      conditions: [],
      resources: [],
    },
  },
  scene: { name: '', time: '', publicDesc: '' },
  facts: [],
  updatedAt: '1970-01-01T00:00:00.000Z',
});

const lossRollOf = (total: number): ParsedRoll => ({
  expr: '1d6',
  raw: '1d6',
  rolls: [[total]],
  kept: [total],
  total,
  check: null,
});

const RULEBOOK = new Coc7RuleBook();
const NO_SANITY: RuleBook = { id: 'coc7' } as unknown as RuleBook;

describe('sanityLossPatch（T-M5-08）', () => {
  it('SAN 检定失败（roll 80 > san 55）→ 损失表 fail=1d6，按损失骰扣除', () => {
    const result = sanityLossPatch(board(), 'm1', 80, lossRollOf(4), RULEBOOK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lossExpr).toBe('1d6');
    expect(result.loss).toBe(4);
    expect(result.patch.pcs?.m1?.sheet).toMatchObject({ san: 51 });
  });

  it('SAN 检定普通成功（55 ≥ roll 30 > 27）→ 普通成功档 1d2', () => {
    const result = sanityLossPatch(board(), 'm1', 30, lossRollOf(2), RULEBOOK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lossExpr).toBe('1d2');
    expect(result.patch.pcs?.m1?.sheet).toMatchObject({ san: 53 });
  });

  it('损失超过当前 SAN → 扣到 0 为止（COC7 理智归零）', () => {
    const result = sanityLossPatch(board(3), 'm1', 90, lossRollOf(5), RULEBOOK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.loss).toBe(3);
    expect(result.patch.pcs?.m1?.sheet).toMatchObject({ san: 0 });
  });

  it('patch 可直接通过乐观锁写路径落盘（引擎与 Host 同一条写路径）', () => {
    const produced = sanityLossPatch(board(), 'm1', 80, lossRollOf(6), RULEBOOK);
    expect(produced.ok).toBe(true);
    if (!produced.ok) return;
    const applied = applyStatePatch(board(), produced.patch, 4);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.next.version).toBe(5);
    expect(applied.next.pcs.m1?.sheet).toMatchObject({ san: 49 });
  });

  it('查无此 PC → pc-not-found 拒绝', () => {
    expect(sanityLossPatch(board(), 'ghost', 80, lossRollOf(4), RULEBOOK)).toEqual({
      ok: false,
      reason: 'pc-not-found',
    });
  });

  it('规则书无 sanityRule 能力 → sanity-rule-missing（不掷骰、不出 patch）', () => {
    expect(sanityLossPatch(board(), 'm1', 80, lossRollOf(4), NO_SANITY)).toEqual({
      ok: false,
      reason: 'sanity-rule-missing',
    });
  });

  it('5e 卡无 san 字段 → rulebook-mismatch（E-AI-01 防呆，设计 §5.4）', () => {
    expect(sanityLossPatch(board5e(), 'm1', 80, lossRollOf(4), RULEBOOK)).toEqual({
      ok: false,
      reason: 'rulebook-mismatch',
    });
  });
});

describe('hpPatch（T-M8-03，FR-25）', () => {
  it('伤害：hp.current = clamp(current − total)（22 − 7 = 15）', () => {
    const result = hpPatch(board5e(), 'm1', 'damage', lossRollOf(7));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.applied).toBe(7);
    const sheet = result.patch.pcs?.m1?.sheet;
    expect(sheet).toMatchObject({ hp: { current: 15, max: 22 } });
  });

  it('治疗：hp.current = clamp(current + total)（12 + 6 = 18）', () => {
    const result = hpPatch(board5e(12), 'm1', 'heal', lossRollOf(6));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.applied).toBe(6);
    expect(result.patch.pcs?.m1?.sheet).toMatchObject({ hp: { current: 18, max: 22 } });
  });

  it('伤害下限 clamp 0：过量伤害只扣到 0（applied 反映实际变动）', () => {
    const result = hpPatch(board5e(), 'm1', 'damage', lossRollOf(50));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.applied).toBe(22);
    expect(result.patch.pcs?.m1?.sheet).toMatchObject({ hp: { current: 0, max: 22 } });
  });

  it('治疗上限 clamp max：溢出治疗不突破 max', () => {
    const result = hpPatch(board5e(20), 'm1', 'heal', lossRollOf(9));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.applied).toBe(2);
    expect(result.patch.pcs?.m1?.sheet).toMatchObject({ hp: { current: 22, max: 22 } });
  });

  it('COC 卡无 hp.max/current 结构 → rulebook-mismatch（E-AI-01 防呆）', () => {
    expect(hpPatch(board(), 'm1', 'damage', lossRollOf(4))).toEqual({
      ok: false,
      reason: 'rulebook-mismatch',
    });
  });

  it('查无此 PC → pc-not-found 拒绝', () => {
    expect(hpPatch(board5e(), 'ghost', 'heal', lossRollOf(4))).toEqual({
      ok: false,
      reason: 'pc-not-found',
    });
  });

  it('patch 可直接通过乐观锁写路径落盘（引擎与 Host 同一条写路径）', () => {
    const produced = hpPatch(board5e(), 'm1', 'damage', lossRollOf(5));
    expect(produced.ok).toBe(true);
    if (!produced.ok) return;
    const applied = applyStatePatch(board5e(), produced.patch, 4);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.next.version).toBe(5);
    expect(applied.next.pcs.m1?.sheet).toMatchObject({ hp: { current: 17, max: 22 } });
  });
});

/** 带资源与状态的 5e 板（T-M12-02） */
const boardWithResources = (): StateBoard => {
  const base = board5e();
  base.pcs['m1'] = {
    ...base.pcs['m1']!,
    conditions: [{ label: '重伤', note: '左臂' }],
    resources: [
      { name: '一环法术位', current: 2, max: 3, resetOn: 'long_rest' },
      { name: '箭矢', current: 5, max: 20, resetOn: 'none' },
    ],
  };
  return base;
};

describe('resourcePatch（T-M12-02，FR-38）', () => {
  it('消耗：clamp(current+delta, 0, max)，前后值回传供回注文案', () => {
    const produced = resourcePatch(boardWithResources(), 'm1', '一环法术位', -1);
    expect(produced.ok).toBe(true);
    if (!produced.ok) return;
    expect(produced.before).toBe(2);
    expect(produced.after).toBe(1);
    const pc = produced.patch.pcs?.['m1'];
    expect(pc?.resources[0]?.current).toBe(1);
  });

  it('下限夹逼：消耗量超过余量时停在 0（不出现负数）', () => {
    const produced = resourcePatch(boardWithResources(), 'm1', '箭矢', -99);
    expect(produced.ok).toBe(true);
    if (!produced.ok) return;
    expect(produced.after).toBe(0);
  });

  it('上限夹逼：恢复量超过上限时停在 max', () => {
    const produced = resourcePatch(boardWithResources(), 'm1', '一环法术位', 99);
    expect(produced.ok).toBe(true);
    if (!produced.ok) return;
    expect(produced.after).toBe(3);
  });

  it('资源不存在 / PC 不存在 → 拒绝（E-AI-01 上游，不产生 patch）', () => {
    expect(resourcePatch(boardWithResources(), 'm1', '不存在的资源', -1)).toEqual({
      ok: false,
      reason: 'resource-not-found',
    });
    expect(resourcePatch(boardWithResources(), 'm9', '箭矢', -1)).toEqual({
      ok: false,
      reason: 'pc-not-found',
    });
  });

  it('整体覆盖语义：patch 必须带原 conditions 与全部资源，否则 Host 维护的数据会被抹掉', () => {
    const produced = resourcePatch(boardWithResources(), 'm1', '箭矢', -2);
    expect(produced.ok).toBe(true);
    if (!produced.ok) return;
    const lock = applyStatePatch(boardWithResources(), produced.patch, 4);
    expect(lock.ok).toBe(true);
    if (!lock.ok) return;
    // 条件与其他资源都在——这是「patch.pcs[key] 替换整条 PC」的必然要求
    expect(lock.next.pcs['m1']?.conditions).toEqual([{ label: '重伤', note: '左臂' }]);
    expect(lock.next.pcs['m1']?.resources).toEqual([
      { name: '一环法术位', current: 2, max: 3, resetOn: 'long_rest' },
      { name: '箭矢', current: 3, max: 20, resetOn: 'none' },
    ]);
  });

  it('HP / 理智写路径同样带资源（同一整体覆盖语义）', () => {
    const board5eWithRes = boardWithResources();
    const hp = hpPatch(board5eWithRes, 'm1', 'damage', { ...lossRollOf(5), expr: '1d8' });
    expect(hp.ok).toBe(true);
    if (!hp.ok) return;
    expect(hp.patch.pcs?.['m1']?.resources).toHaveLength(2);
    expect(hp.patch.pcs?.['m1']?.conditions).toEqual([{ label: '重伤', note: '左臂' }]);
  });
});
