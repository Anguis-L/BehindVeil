import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { DiceAuditEntry } from '../domain/dice/audit.js';
import { createDiceAuditor, type DiceAuditInput } from '../domain/dice/audit.js';
import { rollDice } from '../domain/dice/evaluator.js';
import { createCsprngRandom } from '../domain/dice/random.js';
import { Coc7RuleBook } from '../domain/rulebook/coc7.js';
import { createDataLayout } from '../adapters/storage/layout.js';
import { formatReplayReport, replayAuditFile, replayEntry } from './audit-replay.js';

/**
 * T-M4-04：审计复现校验器（NFR-04、决议 D-04）。
 * 门禁 TC-NFR-04-002：抽样 1000 条重放全一致；篡改任一字段必须被检出。
 */

const created: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'bv-replay-'));
  created.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const RULEBOOK = new Coc7RuleBook();

/** 覆盖各类骰式：多骰组、修改器、四则、命运骰、判定后缀（含 >=/=） */
const EXPRS = [
  '1d100',
  '4d6kh3',
  '2d6+3<=8',
  '1d100<=50',
  '3d6+2d10-1*2',
  '4dF',
  '1d20+5>=13',
  '1d6=3',
];

function makeEntries(count: number): DiceAuditEntry[] {
  const random = createCsprngRandom();
  const entries: DiceAuditEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const expr = EXPRS[i % EXPRS.length] ?? '1d100';
    const roll = rollDice(expr, { random, rulebook: RULEBOOK, kind: 'skill' });
    entries.push({
      seq: String(i + 1).padStart(6, '0'),
      ts: '2026-09-25T12:00:00.000Z',
      rollId: `roll-${i}`,
      roomId: 'room-1',
      sessionId: 'session-1',
      actor: 'member-1',
      hidden: i % 5 === 0,
      expr: roll.expr,
      rolls: roll.rolls,
      kept: roll.kept,
      total: roll.total,
      check: roll.check,
    });
  }
  return entries;
}

async function writeAuditFile(entries: DiceAuditEntry[]): Promise<string> {
  const dir = await makeTmpDir();
  const file = path.join(dir, 'audit-dice.jsonl');
  await writeFile(file, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8');
  return file;
}

describe('抽样重放（TC-NFR-04-002）', () => {
  it('1000 条真实掷骰流水重放全一致', async () => {
    const file = await writeAuditFile(makeEntries(1000));

    const report = await replayAuditFile(file);

    expect(report.total).toBe(1000);
    expect(report.matched).toBe(1000);
    expect(report.mismatches).toEqual([]);
    expect(report.badLines).toBe(0);
  });

  it('真实落账链路落下的流水同样可复现（端到端）', async () => {
    const dir = await makeTmpDir();
    const layout = createDataLayout(dir);
    const auditor = createDiceAuditor(layout);
    const random = createCsprngRandom();

    for (let i = 0; i < 10; i += 1) {
      const roll = rollDice('1d100<=60', { random, rulebook: RULEBOOK, kind: 'skill' });
      const input: DiceAuditInput = {
        roomId: 'room-1',
        sessionId: 'session-1',
        actor: 'member-1',
        hidden: false,
        expr: roll.expr,
        rolls: roll.rolls,
        kept: roll.kept,
        total: roll.total,
        check: roll.check,
      };
      await auditor.record(input);
    }
    await auditor.close();

    const report = await replayAuditFile(layout.auditDiceFile);
    expect(report.total).toBe(10);
    expect(report.mismatches).toEqual([]);
  });
});

describe('篡改必被检出（防「算错也看不出来」）', () => {
  it('改 total', async () => {
    const entries = makeEntries(20);
    const victim = entries[3];
    if (victim) victim.total = victim.total + 1;

    const report = await replayAuditFile(await writeAuditFile(entries));

    expect(report.mismatches).toHaveLength(1);
    expect(report.mismatches[0]?.seq).toBe('000004');
    expect(report.mismatches[0]?.reason).toContain('total 不一致');
  });

  it('改 rolls（换一组骰值）', async () => {
    const entries = makeEntries(20);
    const victim = entries[5];
    if (victim) {
      // victim 循环到 4dF（dF 值域 {-1,0,+1}）：全 +1 重算 total=4，而原始 total
      // 恰好也是 4 的概率 1/81——那种情况下篡改被 total 比对漏掉，用例 flaky。
      // 原始 total=4 时改投全 -1（重算 -4），构造性保证「只改 rolls」必被检出。
      victim.rolls =
        victim.total === 4
          ? victim.rolls.map((group) => group.map(() => -1))
          : victim.rolls.map((group) => group.map(() => 1));
    }

    const report = await replayAuditFile(await writeAuditFile(entries));

    expect(report.mismatches).toHaveLength(1);
    expect(report.mismatches[0]?.seq).toBe('000006');
  });

  it('改 kept', async () => {
    const entries = makeEntries(20);
    const victim = entries[7];
    if (victim) victim.kept = [999];

    const report = await replayAuditFile(await writeAuditFile(entries));

    expect(report.mismatches).toHaveLength(1);
    expect(report.mismatches[0]?.reason).toContain('kept 不一致');
  });

  it('改判定结果（check.outcome）', async () => {
    const entries = makeEntries(40);
    const victim = entries.find((e) => e.check !== null);
    expect(victim?.check).toBeTruthy();
    if (victim?.check) {
      // 换成一个必定与当前不同的 outcome：改完就一定不一致，不必用弱断言兜底
      victim.check = {
        ...victim.check,
        outcome: victim.check.outcome === 'success' ? 'critical' : 'success',
      };
    }

    const report = await replayAuditFile(await writeAuditFile(entries));

    expect(report.mismatches).toHaveLength(1);
    expect(report.mismatches[0]?.seq).toBe(victim?.seq);
    expect(report.mismatches[0]?.reason).toContain('check 不一致');
  });

  it('骰值数量与表达式不符：重放直接失败（不允许拿别的值凑）', async () => {
    const entries = makeEntries(5);
    const victim = entries[0];
    if (victim) victim.rolls = [];

    const report = await replayAuditFile(await writeAuditFile(entries));

    expect(report.mismatches[0]?.reason).toContain('重放失败');
  });

  it('未知规则书无法复现（旧流水或手工篡改可能出现枚举外的值）', () => {
    const entry = makeEntries(1)[0];
    expect(entry).toBeDefined();
    // 规则书是枚举，测试要造枚举外的值只能显式窄化：模拟「未来规则书/被篡改」的流水
    const bogusCheck = {
      ...(entry as DiceAuditEntry).check,
      rulebook: 'coc9',
    } as unknown as DiceAuditEntry['check'];
    const tampered: DiceAuditEntry = { ...(entry as DiceAuditEntry), check: bogusCheck };

    expect(replayEntry(tampered)?.reason).toContain('未知规则书');
  });

  it('5e 判定记录可复现（v2：dnd5e 已是已知规则书）', () => {
    const entry = makeEntries(1)[0] as DiceAuditEntry;
    const fiveE: DiceAuditEntry = {
      ...entry,
      expr: '1d20+5>=13',
      rolls: [[8]],
      kept: [8],
      total: 13,
      check: {
        rulebook: 'dnd5e',
        kind: 'ability',
        target: 13,
        difficulty: 'normal',
        op: '>=',
        outcome: 'success',
      },
    };
    expect(replayEntry(fiveE)).toBeNull();
  });

  it('优势骰（adv）展开后的流水可复现：kept 与判定都能算回', () => {
    const entry = makeEntries(1)[0] as DiceAuditEntry;
    const adv: DiceAuditEntry = {
      ...entry,
      expr: '2d20kh1+5>=13',
      rolls: [[3, 18]],
      kept: [18],
      total: 23,
      check: {
        rulebook: 'dnd5e',
        kind: 'ability',
        target: 13,
        difficulty: 'normal',
        op: '>=',
        outcome: 'success',
      },
    };
    expect(replayEntry(adv)).toBeNull();

    // 篡改保留值必被检出（展开后的 expr 与 kept 必须自洽）
    expect(replayEntry({ ...adv, kept: [3] })?.reason).toContain('kept 不一致');
  });

  it('nat20 开关不同 → 复现判定不一致（房规快照是判定的一部分）', () => {
    const entry = makeEntries(1)[0] as DiceAuditEntry;
    const nat20: DiceAuditEntry = {
      ...entry,
      expr: '1d20>=15',
      rolls: [[20]],
      kept: [20],
      total: 20,
      check: {
        rulebook: 'dnd5e',
        kind: 'ability',
        target: 15,
        difficulty: 'normal',
        op: '>=',
        outcome: 'critical',
        nat20Rule: 'all_d20',
      },
    };
    expect(replayEntry(nat20)).toBeNull();

    // 抹掉房规快照 → 按默认 attack_only 重算得 success，与记录的 critical 不符
    const stripped: DiceAuditEntry = {
      ...nat20,
      check: { ...nat20.check, nat20Rule: undefined } as DiceAuditEntry['check'],
    };
    expect(replayEntry(stripped)?.reason).toContain('check 不一致');
  });

  it('generic 判定记录可复现（v3：档表快照随记录还原，FR-40）', () => {
    const entry = makeEntries(1)[0] as DiceAuditEntry;
    const generic: DiceAuditEntry = {
      ...entry,
      expr: '2d6+2>=7',
      rolls: [[5, 4]],
      kept: [5, 4],
      total: 11,
      check: {
        rulebook: 'generic',
        kind: 'check',
        target: 7,
        difficulty: 'normal',
        op: '>=',
        outcome: 'critical',
        genericGrades: [{ name: 'critical', when: 'total>=10' }],
      },
    };
    expect(replayEntry(generic)).toBeNull();

    // 抹掉档表快照 → 按布尔比较重算得 success，与记录的 critical 不符
    const stripped: DiceAuditEntry = {
      ...generic,
      check: { ...generic.check, genericGrades: undefined } as DiceAuditEntry['check'],
    };
    expect(replayEntry(stripped)?.reason).toContain('check 不一致');
  });
});

describe('报告渲染（CLI 出口）', () => {
  it('全一致时只报汇总行', () => {
    const lines = formatReplayReport({ total: 1000, matched: 1000, mismatches: [], badLines: 0 });
    expect(lines).toEqual(['审计复现：1000/1000 条一致']);
  });

  it('有坏行与不一致时逐条列出，超过 20 条折叠', () => {
    const mismatches = Array.from({ length: 23 }, (_, i) => ({
      seq: String(i + 1).padStart(6, '0'),
      reason: `total 不一致：重算 ${i} ≠ 记录 ${i + 1}`,
    }));

    const lines = formatReplayReport({ total: 30, matched: 7, mismatches, badLines: 3 });

    expect(lines[0]).toBe('审计复现：7/30 条一致');
    expect(lines[1]).toBe('坏行 3 条（已跳过）');
    expect(lines).toHaveLength(23); // 汇总 + 坏行 + 20 条明细 + 折叠行
    expect(lines.at(-1)).toBe('…另有 3 条不一致');
  });
});

describe('文件级容错', () => {
  it('坏行跳过并计数，不中断校验', async () => {
    const entries = makeEntries(3);
    const file = await writeAuditFile(entries);
    await writeFile(file, '{ 不是 JSON\n{"seq":"000009"}\n', { flag: 'a' });

    const report = await replayAuditFile(file);

    expect(report.total).toBe(3);
    expect(report.badLines).toBe(2);
    expect(report.mismatches).toEqual([]);
  });

  it('文件不存在视为空流水（首次启动尚未掷骰）', async () => {
    const dir = await makeTmpDir();

    const report = await replayAuditFile(path.join(dir, 'missing.jsonl'));

    expect(report).toEqual({ total: 0, matched: 0, mismatches: [], badLines: 0 });
  });
});
