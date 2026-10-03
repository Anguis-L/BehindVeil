import { readFile, readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SCHEMA_VERSION, readSchemaVersion, type ArchiveKind } from '@behindveil/shared';
import { JsonlStore } from '../adapters/storage/jsonl-store.js';
import type { DiceAuditEntry } from '../domain/dice/audit.js';
import { DiceAuditEntrySchema } from '../domain/dice/audit.js';
import { replayEntry } from '../tools/audit-replay.js';
import { PAYLOAD_SCHEMAS } from './aidle-migrate.js';

/**
 * aidle-verify-backup：备份完整性校验 CLI（T-M10-02，FR-32，设计 §5.2）。
 *
 * 对一个备份目录出报告：
 * 1. JSONL 解析率（逐文件 records/badLines）；
 * 2. 骰子审计流水复算抽样（tools/audit-replay 同一复现器，均匀抽样默认 100 条）；
 * 3. rooms/ 下的 JSON：JSON.parse + v1 存档再过 payload Schema（v2.0 未迁移内容只查完整性，
 *    备份必须忠实镜像源，不追问版本）；
 * 4. 其余文件清点存在性。
 *
 * 退出码：0 = 全部一致；1 = 存在坏行/复算不一致/JSON 损坏。
 * 用法：node packages/server/dist/cli/aidle-verify-backup.js <backupDir> [--sample N]
 */

export interface VerifyBackupResult {
  readonly ok: boolean;
  readonly lines: readonly string[];
}

export async function runVerifyBackup(
  backupDir: string,
  opts: { sample?: number } = {},
): Promise<VerifyBackupResult> {
  const lines: string[] = [];
  const sampleSize = opts.sample ?? 100;

  const files: Array<{ rel: string; abs: string }> = [];
  await collect(backupDir, '', files);
  if (files.length === 0) {
    return { ok: false, lines: [`备份目录为空或不可读：${backupDir}`] };
  }

  // ---- 1. JSONL 解析率 ----
  let jsonlBad = 0;
  let jsonlRecords = 0;
  for (const file of files) {
    if (!file.rel.endsWith('.jsonl')) continue;
    const { records, badLines } = await new JsonlStore(file.abs).readAll();
    jsonlRecords += records.length;
    jsonlBad += badLines;
    if (badLines > 0) lines.push(`  ${file.rel}：坏行 ${badLines} 条`);
  }
  lines.push(`JSONL：解析 ${jsonlRecords} 条记录，坏行 ${jsonlBad} 条。`);

  // ---- 2. 骰子审计复算抽样 ----
  const auditFile = files.find((f) =>
    f.rel.replaceAll('\\', '/').endsWith('logs/audit-dice.jsonl'),
  );
  if (auditFile) {
    const auditEntries = await readAuditEntries(auditFile.abs);
    const sampled = sampleEvenly(auditEntries, sampleSize);
    let mismatched = 0;
    for (const entry of sampled) {
      if (replayEntry(entry) !== null) mismatched += 1;
    }
    lines.push(
      `审计复算：抽样 ${sampled.length}/${auditEntries.length} 条，${mismatched === 0 ? '全部一致' : `${mismatched} 条不一致`}`,
    );
    jsonlBad += mismatched; // 纳入退出码口径
  } else {
    lines.push('审计复算：备份内无 audit-dice.jsonl，跳过。');
  }

  // ---- 3. rooms/ 下 JSON：解析 + v1 存档 Schema 校验 ----
  let jsonChecked = 0;
  let jsonFailed = 0;
  for (const file of files) {
    if (!file.rel.replaceAll('\\', '/').startsWith('rooms/') || !file.rel.endsWith('.json'))
      continue;
    let doc: unknown;
    try {
      doc = JSON.parse(await readFile(file.abs, 'utf8')) as unknown;
    } catch (err) {
      jsonFailed += 1;
      lines.push(`  ${file.rel}：JSON 损坏（${err instanceof Error ? err.message : String(err)}）`);
      continue;
    }
    jsonChecked += 1;
    const kind = archiveKindOf(file.rel);
    if (kind === null) continue;
    if (readSchemaVersion(doc) !== SCHEMA_VERSION) continue; // 未迁移镜像：只查解析
    const payload =
      kind === 'members' ? (doc as { members?: unknown })['members'] : stripVersionField(doc);
    const parsed = PAYLOAD_SCHEMAS[kind].safeParse(payload);
    if (!parsed.success) {
      jsonFailed += 1;
      const issue = parsed.error.issues[0];
      lines.push(`  ${file.rel}：Schema 校验失败（${issue?.path.join('.')}）`);
    }
  }
  lines.push(`存档 JSON：检查 ${jsonChecked} 个，失败 ${jsonFailed} 个。`);

  const ok = jsonlBad === 0 && jsonFailed === 0;
  lines.unshift(ok ? '备份校验通过。' : '备份校验存在问题：');
  return { ok, lines };
}

// ---- helpers ----

async function collect(
  dir: string,
  rel: string,
  out: Array<{ rel: string; abs: string }>,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      await collect(abs, relPath, out);
    } else if (entry.isFile()) {
      out.push({ rel: relPath, abs });
    }
  }
}

/** rooms/<roomId>/{room,members,roster}.json 与 rooms/<roomId>/sessions/<sid>/{session,state}.json → kind */
function archiveKindOf(relPath: string): ArchiveKind | null {
  const norm = relPath.replaceAll('\\', '/');
  const roomLevel = /^rooms\/[^/]+\/(room|members|roster)\.json$/u.exec(norm);
  if (roomLevel) return roomLevel[1] === 'room' ? 'room' : (roomLevel[1] as 'members' | 'roster');
  const sessionLevel = /^rooms\/[^/]+\/sessions\/[^/]+\/(session|state)\.json$/u.exec(norm);
  if (sessionLevel) return sessionLevel[1] === 'session' ? 'session' : 'state';
  return null;
}

function stripVersionField(doc: unknown): unknown {
  if (doc === null || typeof doc !== 'object') return doc;
  const { schemaVersion: _schemaVersion, ...payload } = doc as Record<string, unknown>;
  return payload;
}

async function readAuditEntries(file: string): Promise<DiceAuditEntry[]> {
  const raw = await readFile(file, 'utf8');
  const entries: DiceAuditEntry[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = DiceAuditEntrySchema.safeParse(JSON.parse(line) as unknown);
      if (parsed.success) entries.push(parsed.data);
    } catch {
      // 坏行已计入 JSONL 解析率，此处只收集可复算条目
    }
  }
  return entries;
}

/** 均匀抽样：覆盖首尾，样本数 ≤ 总数时全取 */
function sampleEvenly<T>(items: T[], sampleSize: number): T[] {
  if (items.length <= sampleSize) return items;
  const picked: T[] = [];
  for (let i = 0; i < sampleSize; i += 1) {
    picked.push(items[Math.floor((i * items.length) / sampleSize)] as T);
  }
  return picked;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  if (dir === undefined) {
    process.stdout.write(
      '用法：node packages/server/dist/cli/aidle-verify-backup.js <backupDir> [--sample N]\n',
    );
    process.exitCode = 1;
    return;
  }
  const sampleFlag = args.indexOf('--sample');
  const sample = sampleFlag >= 0 ? Number(args[sampleFlag + 1]) : undefined;
  const result = await runVerifyBackup(dir, {
    sample: sample !== undefined && Number.isInteger(sample) && sample > 0 ? sample : undefined,
  });
  process.stdout.write(`${result.lines.join('\n')}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
