import { describe, expect, it } from 'vitest';
import type { Message, RollCheck } from '@behindveil/shared';
import { diceKindLabel, diceNatBadge, diceTargetLabel } from './dice-card.js';

/**
 * T-M7-05/06：骰子卡判定展示（v2 FR-21/22）。
 * 只测「展示什么」，判定本身由服务端规则书负责（dnd5e.test.ts 覆盖）。
 */

function diceMsg(check: RollCheck | null, hidden = false): Message {
  return {
    seq: 1,
    ts: '2026-09-29T00:00:00.000Z',
    sessionId: 's_1',
    type: 'dice',
    hidden,
    roll: {
      expr: '1d20+5>=13',
      rolls: [[8]],
      kept: [8],
      total: 13,
      ...(check ? { check } : {}),
      audit: { seq: '000001', ts: '2026-09-29T00:00:00.000Z', rollId: 'r_1' },
    },
  } as Message;
}

const base: RollCheck = {
  rulebook: 'dnd5e',
  kind: 'ability',
  target: 13,
  difficulty: 'normal',
  outcome: 'success',
  op: '>=',
};

describe('diceKindLabel（判定种类中文名）', () => {
  it('5e 四种', () => {
    expect(diceKindLabel(diceMsg({ ...base, kind: 'ability' }))).toBe('属性检定');
    expect(diceKindLabel(diceMsg({ ...base, kind: 'save' }))).toBe('豁免检定');
    expect(diceKindLabel(diceMsg({ ...base, kind: 'attack' }))).toBe('攻击检定');
    expect(diceKindLabel(diceMsg({ ...base, kind: 'initiative' }))).toBe('先攻');
  });

  it('COC 四种不回归', () => {
    expect(diceKindLabel(diceMsg({ ...base, kind: 'skill' }))).toBe('技能检定');
    expect(diceKindLabel(diceMsg({ ...base, kind: 'sanity' }))).toBe('理智检定');
    expect(diceKindLabel(diceMsg({ ...base, kind: 'opposed' }))).toBe('对抗检定');
    expect(diceKindLabel(diceMsg({ ...base, kind: 'luck' }))).toBe('幸运检定');
  });

  it('无判定记录（纯骰值）或非骰子消息 → 不展示', () => {
    expect(diceKindLabel(diceMsg(null))).toBeNull();
    expect(
      diceKindLabel({
        seq: 1,
        ts: '',
        sessionId: 's_1',
        type: 'ic',
        senderId: 'm_1',
        content: '我推门',
      } as Message),
    ).toBeNull();
  });
});

describe('diceTargetLabel（DC / AC）', () => {
  it('属性检定与豁免写 DC', () => {
    expect(diceTargetLabel(diceMsg({ ...base, kind: 'save', target: 12 }))).toBe('DC 12');
  });

  it('攻击写 AC（目标就是护甲等级）', () => {
    expect(diceTargetLabel(diceMsg({ ...base, kind: 'attack', target: 16 }))).toBe('AC 16');
  });

  it('COC 的 <= 目标值不重复展示（骰式里已有）', () => {
    expect(
      diceTargetLabel(diceMsg({ ...base, rulebook: 'coc7', op: '<=', target: 60 })),
    ).toBeNull();
  });

  it('无判定记录 → 不展示', () => {
    expect(diceTargetLabel(diceMsg(null))).toBeNull();
  });
});

describe('diceNatBadge（nat20 / nat1）', () => {
  it('5e 大成功 → NAT 20，大失败 → NAT 1', () => {
    expect(diceNatBadge(diceMsg({ ...base, kind: 'attack', outcome: 'critical' }))).toBe('NAT 20');
    expect(diceNatBadge(diceMsg({ ...base, kind: 'attack', outcome: 'fumble' }))).toBe('NAT 1');
  });

  it('普通成功/失败不挂面值徽章', () => {
    expect(diceNatBadge(diceMsg({ ...base, outcome: 'success' }))).toBeNull();
    expect(diceNatBadge(diceMsg({ ...base, outcome: 'fail' }))).toBeNull();
  });

  it('COC 的大成功不叫 nat20（骰值 1 是大成功，语义不同）', () => {
    const coc: RollCheck = {
      rulebook: 'coc7',
      kind: 'skill',
      target: 60,
      difficulty: 'normal',
      outcome: 'critical',
      grade: 'normal',
    };
    expect(diceNatBadge(diceMsg(coc))).toBeNull();
  });

  it('暗骰不展示徽章（结果本身就看不了）', () => {
    expect(diceNatBadge(diceMsg({ ...base, outcome: 'critical' }, true))).toBeNull();
  });
});
