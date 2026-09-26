import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { DiceAuditEntry } from '../domain/dice/audit.js';
import { DiceAuditEntrySchema } from '../domain/dice/audit.js';
import { replayRoll } from '../domain/dice/evaluator.js';
import { DiceExpressionError } from '../domain/dice/parser.js';
import { Coc7RuleBook } from '../domain/rulebook/coc7.js';
import type { RuleBook } from '../domain/rulebook/types.js';
import type { ParsedRoll } from '../domain/dice/evaluator.js';
import type { RollCheck } from '@behindveil/shared';

/**
 * 审计复现校验器（T-M4-04，NFR-04；语义按决议 D-04）。
 *
 * 逐条读 `data/logs/audit-dice.jsonl`，用流水里的 `expr + rolls` 重算 kept/total/check，
 * 与当时记录逐一比对——不一致即说明求值或判定被改过（或流水被篡改），必须暴露。
 * 校验的是「算得对不对」，不是「能否摇出同样的点数」（CSPRNG 无种子，本就不可回放）。
 *
 * 用法：`node dist/tools/audit-replay.js [audit-file]`
 * 缺省路径 `data/logs/audit-dice.jsonl`；退出码 0 = 全部一致，1 = 存在不一致。
 */

export interface ReplayMismatch {
  seq: string;
  reason: string;
}

export interface ReplayReport {
  /** 参与校验的条目数（坏行不计入） */
  total: number;
  matched: number;
  mismatches: ReplayMismatch[];
  badLines: number;
}

/** v1 仅 COC7（接口按 ADR-04 预留；未知规则书无法复现，直接判不一致） */
const RULEBOOKS: Record<string, RuleBook> = { coc7: new Coc7RuleBook() };

export function rulebookFor(id: string): RuleBook | null {
  return RULEBOOKS[id] ?? null;
}

/** 复现单条审计记录：一致返回 null，不一致返回原因 */
export function replayEntry(entry: DiceAuditEntry): ReplayMismatch | null {
  const check = entry.check;
  const rulebook = rulebookFor(check?.rulebook ?? 'coc7');
  if (!rulebook) {
    return { seq: entry.seq, reason: `未知规则书：${check?.rulebook ?? '(未记录)'}` };
  }

  let roll: ParsedRoll;
  try {
    roll = replayRoll(entry.expr, entry.rolls, {
      rulebook,
      kind: check?.kind ?? 'skill',
      difficulty: check?.difficulty ?? 'normal',
    });
  } catch (err) {
    const detail = err instanceof DiceExpressionError ? err.message : String(err);
    return { seq: entry.seq, reason: `重放失败：${detail}` };
  }

  if (!sameNumbers(roll.kept, entry.kept)) {
    return {
      seq: entry.seq,
      reason: `kept 不一致：重算 ${fmt(roll.kept)} ≠ 记录 ${fmt(entry.kept)}`,
    };
  }
  if (roll.total !== entry.total) {
    return { seq: entry.seq, reason: `total 不一致：重算 ${roll.total} ≠ 记录 ${entry.total}` };
  }
  if (!sameCheck(roll.check, check)) {
    return {
      seq: entry.seq,
      reason: `check 不一致：重算 ${fmt(roll.check)} ≠ 记录 ${fmt(check)}`,
    };
  }
  return null;
}

/** 读整个审计文件并复现（坏行跳过并计数，不中断） */
export async function replayAuditFile(file: string): Promise<ReplayReport> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { total: 0, matched: 0, mismatches: [], badLines: 0 };
    }
    throw err;
  }

  const mismatches: ReplayMismatch[] = [];
  let total = 0;
  let matched = 0;
  let badLines = 0;

  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let record: unknown;
    try {
      record = JSON.parse(line) as unknown;
    } catch {
      badLines += 1;
      continue;
    }
    const parsed = DiceAuditEntrySchema.safeParse(record);
    if (!parsed.success) {
      badLines += 1;
      continue;
    }
    total += 1;
    const mismatch = replayEntry(parsed.data);
    if (mismatch) mismatches.push(mismatch);
    else matched += 1;
  }

  return { total, matched, mismatches, badLines };
}

function sameNumbers(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function sameCheck(a: RollCheck | null, b: RollCheck | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.outcome === b.outcome &&
    (a.grade ?? 'normal') === (b.grade ?? 'normal') &&
    (a.op ?? '<=') === (b.op ?? '<=') &&
    a.target === b.target &&
    a.kind === b.kind &&
    a.difficulty === b.difficulty
  );
}

function fmt(value: unknown): string {
  return JSON.stringify(value);
}

/** 报告渲染（抽成纯函数：CLI 只管 IO，便于单测） */
export function formatReplayReport(report: ReplayReport): string[] {
  const lines = [`审计复现：${report.matched}/${report.total} 条一致`];
  if (report.badLines > 0) lines.push(`坏行 ${report.badLines} 条（已跳过）`);
  for (const mismatch of report.mismatches.slice(0, 20)) {
    lines.push(`#${mismatch.seq} ${mismatch.reason}`);
  }
  if (report.mismatches.length > 20) {
    lines.push(`…另有 ${report.mismatches.length - 20} 条不一致`);
  }
  return lines;
}

async function main(): Promise<void> {
  const file = process.argv[2] ?? 'data/logs/audit-dice.jsonl';
  const report = await replayAuditFile(file);
  process.stdout.write(`${formatReplayReport(report).join('\n')}\n`);
  if (report.mismatches.length > 0) process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
