import { describe, expect, it } from 'vitest';
import { GenericRuleSchema } from '@behindveil/shared';
import {
  executeCheck,
  executeResource,
  type CheckExecutorDeps,
  type PcRoster,
} from './executor.js';
import type { CheckDirective } from './schema.js';
import type { RandomSource } from '../dice/random.js';
import { createRuleBook } from '../rulebook/index.js';
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

describe('generic 规则书检定（v3 FR-40：骰型/方向全配置化）', () => {
  const genericBook = createRuleBook('generic', {
    genericRule: GenericRuleSchema.parse({
      dice: '2d6',
      op: '>=',
      kinds: ['check', 'save'],
      grades: [{ name: 'critical', when: 'total>=10' }],
    }),
  });

  it('骰式 = 主骰+名册修正+配置方向+指令 dc；修正为 0 省略、为负带减号', () => {
    const result = executeCheck(
      directive({ dc: 7 }),
      deps({ roster: rosterOf(2), rulebook: genericBook }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.roll.expr).toBe('2d6+2>=7');
    expect(result.roll.check).toMatchObject({
      rulebook: 'generic',
      kind: 'check',
      target: 7,
      op: '>=',
    });

    const zero = executeCheck(
      directive({ dc: 7 }),
      deps({ roster: rosterOf(0), rulebook: genericBook }),
    );
    expect(zero.ok && zero.roll.expr).toBe('2d6>=7');
    const negative = executeCheck(
      directive({ dc: 7 }),
      deps({ roster: rosterOf(-1), rulebook: genericBook }),
    );
    expect(negative.ok && negative.roll.expr).toBe('2d6-1>=7');
  });

  it('档表快照随判定记录落流水（audit-replay 复现凭据）', () => {
    const result = executeCheck(
      directive({ dc: 7 }),
      deps({ roster: rosterOf(2), rulebook: genericBook }),
    );
    expect(result.ok && result.roll.check?.genericGrades).toEqual([
      { name: 'critical', when: 'total>=10' },
    ]);
  });

  it('不带 dc → E-AI-01（generic 无官方缺省目标值，不发明数值）', () => {
    const result = executeCheck(directive(), deps({ roster: rosterOf(2), rulebook: genericBook }));
    expect(result).toMatchObject({ ok: false, code: 'E-AI-01' });
    if (!result.ok) expect(result.reason).toContain('dc');
  });

  it('kind 取指令值（须在配置 kinds 内），否则缺省 kinds[0]', () => {
    const asSave = executeCheck(
      directive({ dc: 7, kind: 'save' }),
      deps({ roster: rosterOf(2), rulebook: genericBook }),
    );
    expect(asSave.ok && asSave.roll.check?.kind).toBe('save');
    const outOfSet = executeCheck(
      directive({ dc: 7, kind: 'attack' }),
      deps({ roster: rosterOf(2), rulebook: genericBook }),
    );
    expect(outOfSet.ok && outOfSet.roll.check?.kind).toBe('check');
  });
});

describe('默认依赖装配', () => {
  it('缺省即真实名册（状态板实现）+ CSPRNG + COC7：产物形状完整（不校验具体骰值）', () => {
    const board: StateBoard = {
      version: 0,
      pcs: {
        alice: {
          sheet: {
            rulebook: 'coc7',
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
          resources: [],
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

describe('executeResource（T-M12-02，FR-38）', () => {
  /** 最小 COC 板 + 指定资源（爱丽丝） */
  const resBoard = (
    resources: Array<{ name: string; current: number; max: number }>,
  ): StateBoard => ({
    version: 0,
    pcs: {
      m1: {
        sheet: {
          rulebook: 'coc7',
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
        resources: resources.map((r) => ({ ...r, resetOn: 'none' as const })),
      },
    },
    scene: { name: '', time: '', publicDesc: '' },
    facts: [],
    updatedAt: '1970-01-01T00:00:00.000Z',
  });

  it('合法消耗 → 带 key/name/delta，且不掷骰（本指令无随机结构）', () => {
    const result = executeResource(
      { op: 'resource', target: 'pc:m1', name: '箭矢', delta: -2 },
      { board: resBoard([{ name: '箭矢', current: 10, max: 20 }]) },
    );
    expect(result).toEqual({ ok: true, pcName: '爱丽丝', key: 'm1', name: '箭矢', delta: -2 });
  });

  it('余量不足 → E-AI-01（不静默 clamp 成 0，KP 需知情）', () => {
    const result = executeResource(
      { op: 'resource', target: 'pc:m1', name: '箭矢', delta: -5 },
      { board: resBoard([{ name: '箭矢', current: 2, max: 20 }]) },
    );
    expect(result).toMatchObject({ ok: false, code: 'E-AI-01' });
    if (!result.ok) expect(result.reason).toContain('余量不足');
  });

  it('恢复超上限 → E-AI-01', () => {
    const result = executeResource(
      { op: 'resource', target: 'pc:m1', name: '一环法术位', delta: 3 },
      { board: resBoard([{ name: '一环法术位', current: 2, max: 3 }]) },
    );
    expect(result).toMatchObject({ ok: false, code: 'E-AI-01' });
    if (!result.ok) expect(result.reason).toContain('上限');
  });

  it('资源不存在 / PC 不存在 / delta 为 0 → E-AI-01', () => {
    const deps = { board: resBoard([{ name: '箭矢', current: 5, max: 20 }]) };
    expect(
      executeResource({ op: 'resource', target: 'pc:m1', name: '不存在', delta: -1 }, deps),
    ).toMatchObject({ ok: false });
    expect(
      executeResource({ op: 'resource', target: 'pc:m9', name: '箭矢', delta: -1 }, deps),
    ).toMatchObject({ ok: false });
    expect(
      executeResource({ op: 'resource', target: 'pc:m1', name: '箭矢', delta: 0 }, deps),
    ).toMatchObject({ ok: false });
  });
});
