import { describe, expect, it } from 'vitest';
import { executeCheck, type CheckExecutorDeps, type PcRoster } from './executor.js';
import type { CheckDirective } from './schema.js';
import type { RandomSource } from '../dice/random.js';
import { createStateBoardRoster } from '../stateboard/roster.js';
import type { StateBoard } from '@behindveil/shared';

/**
 * T-M3-03：检定执行器（TDD §5.4）。
 * AI 只传技能名——技能值取自名册、骰式由服务端拼出（TC-FR-05-008 的执行侧根基）；
 * 掷骰与判定走 P 轨道引擎（固定随机源下结果确定，TC-NFR-04-003 可测性）。
 */

/** 固定随机源：int 恒返回 n（1d100 场景即骰值 n） */
const fixed = (n: number): RandomSource => ({ int: () => n });

const rosterOf = (value: number): PcRoster => ({
  skillValue: () => ({ found: true, value, name: '爱丽丝' }),
});

const directive = (over: Partial<CheckDirective> = {}): CheckDirective => ({
  op: 'check',
  target: 'pc:alice',
  skill: '侦查',
  difficulty: 'normal',
  ...over,
});

const deps = (over: Partial<CheckExecutorDeps> = {}): CheckExecutorDeps => ({
  roster: rosterOf(60),
  random: fixed(40),
  ...over,
});

describe('技能值取自名册（防篡改根基）', () => {
  it('骰式由服务端拼出：1d100<=名册值，check.target 即技能值', () => {
    const result = executeCheck(directive(), deps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.roll.expr).toBe('1d100<=60');
    expect(result.roll.check).toMatchObject({
      rulebook: 'coc7',
      kind: 'skill',
      target: 60,
      difficulty: 'normal',
    });
    expect(result.pcName).toBe('爱丽丝');
    expect(result.skillValue).toBe(60);
  });

  it('名册值变化直接改变判定目标（指令无法介入数值）', () => {
    const result = executeCheck(directive(), deps({ roster: rosterOf(35) }));
    expect(result.ok && result.roll.expr).toBe('1d100<=35');
  });

  it('原始骰值与总数落盘可复算（审计口径）', () => {
    const result = executeCheck(directive(), deps());
    expect(result.ok && result.roll.rolls).toEqual([[40]]);
    expect(result.ok && result.roll.total).toBe(40);
  });
});

describe('难度档传递（COC7 判定表，P 轨道）', () => {
  it('roll 40 / 技能 60：normal 成功（普通档）', () => {
    const result = executeCheck(directive(), deps());
    expect(result.ok && result.roll.check?.outcome).toBe('success');
    expect(result.ok && result.roll.check?.grade).toBe('normal');
  });

  it('roll 40 / 技能 60：hard 失败（40 > 60/2）', () => {
    const result = executeCheck(directive({ difficulty: 'hard' }), deps());
    expect(result.ok && result.roll.check?.outcome).toBe('fail');
  });

  it('roll 25 / 技能 60：hard 成功（困难档）', () => {
    const result = executeCheck(directive({ difficulty: 'hard' }), deps({ random: fixed(25) }));
    expect(result.ok && result.roll.check).toMatchObject({ outcome: 'success', grade: 'hard' });
  });

  it('roll 1：大成功（criticalMax=1）', () => {
    const result = executeCheck(directive(), deps({ random: fixed(1) }));
    expect(result.ok && result.roll.check?.outcome).toBe('critical');
  });

  it('roll 100 / 技能 60（≥50）：大失败（fumbleHighSkill=100）', () => {
    const result = executeCheck(directive(), deps({ random: fixed(100) }));
    expect(result.ok && result.roll.check?.outcome).toBe('fumble');
  });
});

describe('名册查询失败 → E-AI-01（不计入 R-01 成功）', () => {
  it.each([
    [
      '查无 PC',
      {
        skillValue: () => ({ found: false, reason: 'pc-not-found' }),
      } as PcRoster,
      '查无 PC',
    ],
    [
      '无此技能',
      {
        skillValue: () => ({ found: false, reason: 'skill-not-found' }),
      } as PcRoster,
      '无技能',
    ],
  ])('%s → 拒绝执行且原因可读', (_name, roster, reasonPart) => {
    const result = executeCheck(directive(), deps({ roster }));
    expect(result).toMatchObject({ ok: false, code: 'E-AI-01' });
    if (!result.ok) expect(result.reason).toContain(reasonPart);
  });

  it('失败分支不产出掷骰结果（不掷骰的接口前提）', () => {
    const result = executeCheck(
      directive(),
      deps({ roster: { skillValue: () => ({ found: false, reason: 'pc-not-found' }) } }),
    );
    expect('roll' in result).toBe(false);
  });
});

describe('默认依赖装配', () => {
  it('缺省即真实名册（状态板实现）+ CSPRNG + COC7：产物形状完整（不校验具体骰值）', () => {
    const board: StateBoard = {
      version: 0,
      pcs: {
        alice: {
          sheet: {
            playerName: '爱丽丝',
            occupation: '',
            str: 0,
            con: 0,
            siz: 0,
            dex: 0,
            app: 0,
            int: 0,
            pow: 0,
            edu: 0,
            luck: 0,
            hp: 0,
            mp: 0,
            san: 0,
            db: '0',
            build: '0',
            skills: { 侦查: 60 },
          },
          conditions: [],
        },
      },
      scene: { name: '', time: '', publicDesc: '' },
      facts: [],
      updatedAt: '1970-01-01T00:00:00.000Z',
    };
    const result = executeCheck(directive(), { roster: createStateBoardRoster(board) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.roll.expr).toBe('1d100<=60');
    expect(result.roll.check).not.toBeNull();
    expect(result.roll.rolls[0]).toHaveLength(1);
  });
});
