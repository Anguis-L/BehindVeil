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
    if (victim) victim.rolls = victim.rolls.map((group) => group.map(() => 1));

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
    expect(victim).toBeDefined();
    if (victim?.check) victim.check = { ...victim.check, outcome: 'critical' };

    const report = await replayAuditFile(await writeAuditFile(entries));

    expect(report.mismatches.length).toBeGreaterThan(0);
    expect(report.mismatches[0]?.reason).toContain('check 不一致');
  });

  it('骰值数量与表达式不符：重放直接失败（不允许拿别的值凑）', async () => {
    const entries = makeEntries(5);
    const victim = entries[0];
    if (victim) victim.rolls = [];

    const report = await replayAuditFile(await writeAuditFile(entries));

    expect(report.mismatches[0]?.reason).toContain('重放失败');
  });

  it('未知规则书无法复现', () => {
    const entry = makeEntries(1)[0];
    expect(entry).toBeDefined();
    const tampered: DiceAuditEntry = {
      ...(entry as DiceAuditEntry),
      check: {
        rulebook: 'dnd5e',
        kind: 'skill',
        target: 10,
        difficulty: 'normal',
        outcome: 'success',
      },
    };

    expect(replayEntry(tampered)?.reason).toContain('未知规则书');
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
