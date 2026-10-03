import { cp, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  MemberSchema,
  SCHEMA_VERSION,
  SessionSchema,
  StateBoardSchema,
  WorldBookSchema,
  migrateArchive,
  readSchemaVersion,
} from '@behindveil/shared';
import { z } from 'zod';
import { listArchiveFiles, type ArchiveFile } from '../adapters/storage/archive-walk.js';
import { JsonStore } from '../adapters/storage/json-store.js';
import { JsonlStore } from '../adapters/storage/jsonl-store.js';
import { createDataLayout } from '../adapters/storage/layout.js';
import { RoomFileSchema } from '../domain/session/rooms.js';
import { RoomRosterSchema } from '../domain/stateboard/declare.js';

/**
 * aidle-migrate：离线存档迁移 CLI（T-M10-01，FR-30 / ADR-3-05，设计 §5.2）。
 *
 * 流程：校验 → 整目录备份 data/ → data/backup-pre-migrate-<ts>/ → 原地升级 →
 * 全件重解析自检（存档过 Schema + JSONL 解析率）→ 任一步失败即从备份回滚。
 * 离线工具：必须在服务端停止后运行（运行中迁移会与房间串行队列竞争写）。
 *
 * 用法：node packages/server/dist/cli/aidle-migrate.js [dataDir]（默认 ./data）
 * 幂等：全部存档已是当前版本时直接成功返回，不产生备份目录。
 */

export interface MigrateResult {
  readonly ok: boolean;
  /** 面向用户的过程报告（逐行） */
  readonly lines: readonly string[];
  /** 成功迁移时给出备份目录（供回滚/留存） */
  readonly backupDir?: string;
}

/**
 * 自检的 payload Schema（kind → 落盘内容除版本字段外的本体）。
 * aidle-verify-backup 复用同一张表校验备份内的存档。
 */
export const PAYLOAD_SCHEMAS = {
  room: RoomFileSchema,
  members: z.array(MemberSchema),
  roster: RoomRosterSchema,
  session: SessionSchema,
  state: StateBoardSchema,
  worldbook: WorldBookSchema,
} as const;

export async function runMigrate(dataDir: string): Promise<MigrateResult> {
  const lines: string[] = [];
  const fail = (reason: string, backupDir?: string): MigrateResult => ({
    ok: false,
    lines: [...lines, `迁移中止：${reason}`],
    backupDir,
  });

  try {
    await stat(dataDir);
  } catch {
    lines.push(`data/（${dataDir}）不存在，无需迁移。`);
    return { ok: true, lines };
  }

  // ---- 阶段 1：校验（只读，任何损坏/超前版本先于一切写入被拒）----
  const files = await listArchiveFiles(dataDir);
  const pending: Array<{ file: ArchiveFile; doc: unknown }> = [];
  let alreadyCurrent = 0;
  for (const file of files) {
    let doc: unknown;
    try {
      doc = JSON.parse(await readFile(file.absolutePath, 'utf8')) as unknown;
    } catch (err) {
      // 枚举只列路径不查存在性：文件缺失是合法空缺（未进房/未声明等）
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return fail(`${file.relativePath} 不是合法 JSON（${messageOf(err)}）；请先修复该文件再迁移`);
    }
    let version: number;
    try {
      version = readSchemaVersion(doc);
    } catch (err) {
      return fail(`${file.relativePath}：${messageOf(err)}`);
    }
    if (version > SCHEMA_VERSION) {
      return fail(
        `${file.relativePath} 版本 ${version} 超前于当前支持的 ${SCHEMA_VERSION}（存档来自更新版本的服务端，拒绝降级）`,
      );
    }
    if (version === SCHEMA_VERSION) {
      alreadyCurrent += 1;
      continue;
    }
    pending.push({ file, doc });
  }

  if (pending.length === 0) {
    lines.push(`全部存档已是版本 ${SCHEMA_VERSION}（共 ${alreadyCurrent} 个），无需迁移。`);
    return { ok: true, lines };
  }
  lines.push(
    `待迁移 ${pending.length} 个存档（另有 ${alreadyCurrent} 个已是当前版本 ${SCHEMA_VERSION}）。`,
  );

  // ---- 阶段 2：整目录备份（排除历史迁移备份，避免嵌套复制自我膨胀）----
  const backupDir = join(dataDir, `backup-pre-migrate-${timestampSlug()}`);
  try {
    const copied = await copyTree(dataDir, backupDir);
    lines.push(`已整目录备份 data/ → ${relative(dataDir, backupDir)}/（${copied} 个文件）。`);
  } catch (err) {
    return fail(`备份失败，未做任何修改：${messageOf(err)}`);
  }

  // ---- 阶段 3：原地升级（逐文件原子写，JsonStore tmp+fsync+rename）----
  try {
    for (const { file, doc } of pending) {
      const migrated = migrateArchive(file.kind, doc);
      await new JsonStore(file.absolutePath).write(migrated);
      lines.push(`  ${file.relativePath}：→ 版本 ${SCHEMA_VERSION}`);
    }
  } catch (err) {
    await rollback(backupDir, dataDir, lines);
    return fail(`升级失败，已回滚：${messageOf(err)}`, backupDir);
  }

  // ---- 阶段 4：自检（存档重解析 + Schema 校验；JSONL 解析率报告）----
  try {
    lines.push(...(await selfCheck(dataDir)));
  } catch (err) {
    await rollback(backupDir, dataDir, lines);
    return fail(`自检失败，已回滚：${messageOf(err)}`, backupDir);
  }

  lines.push('迁移完成。');
  return { ok: true, lines, backupDir };
}

/** 升级/自检失败后的回滚：把备份逐文件拷回原位（迁移只覆写既有文件，拷回即还原） */
async function rollback(backupDir: string, dataDir: string, lines: string[]): Promise<void> {
  try {
    const restored = await copyTree(backupDir, dataDir);
    lines.push(`  已从 ${relative(dataDir, backupDir)}/ 还原 ${restored} 个文件。`);
  } catch (err) {
    lines.push(`  警告：自动回滚失败（${messageOf(err)}），请手动从 ${backupDir} 恢复。`);
  }
}

async function selfCheck(dataDir: string): Promise<string[]> {
  const report: string[] = [];
  const files = await listArchiveFiles(dataDir);
  if (files.length === 0) report.push('自检：无存档文件。');

  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file.absolutePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue; // 合法空缺
      throw err;
    }
    const doc = JSON.parse(text) as unknown;
    const version = readSchemaVersion(doc);
    if (version !== SCHEMA_VERSION) {
      throw new Error(`${file.relativePath} 升级后版本为 ${version}，期望 ${SCHEMA_VERSION}`);
    }
    const payload =
      file.kind === 'members' ? (doc as { members?: unknown })['members'] : stripVersion(doc);
    const parsed = PAYLOAD_SCHEMAS[file.kind].safeParse(payload);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(
        `${file.relativePath} Schema 校验失败（${issue ? issue.path.join('.') : '(根)'}：${issue?.message ?? ''}）`,
      );
    }
  }
  report.push(`自检：${files.length} 个存档重解析 + Schema 校验全部通过。`);

  // JSONL 追加型不在迁移范围，但顺带报告解析率（全件重解析的一部分）
  const layout = createDataLayout(dataDir);
  const jsonlFiles = [layout.auditDiceFile, layout.directiveLogFile];
  for (const room of await listDirectories(layout.roomsDir)) {
    for (const session of await listDirectories(join(layout.roomsDir, room, 'sessions'))) {
      jsonlFiles.push(join(layout.roomsDir, room, 'sessions', session, 'messages.jsonl'));
    }
  }
  let total = 0;
  let bad = 0;
  for (const file of jsonlFiles) {
    const { records, badLines } = await new JsonlStore(file).readAll();
    total += records.length;
    bad += badLines;
  }
  report.push(`自检：JSONL 解析 ${total} 条记录，坏行 ${bad} 条。`);
  return report;
}

function stripVersion(doc: unknown): unknown {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return doc;
  const { schemaVersion: _schemaVersion, ...payload } = doc as Record<string, unknown>;
  return payload;
}

async function listDirectories(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

const BACKUP_DIR_PREFIX = 'backup-pre-migrate-';

/** 递归复制目录内容；跳过历史迁移备份目录（整目录复制不嵌套复制旧备份） */
async function copyTree(srcDir: string, destDir: string): Promise<number> {
  let count = 0;
  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith(BACKUP_DIR_PREFIX)) continue;
    const src = join(srcDir, entry.name);
    const dest = join(destDir, entry.name);
    if (entry.isDirectory()) {
      count += await copyTree(src, dest);
    } else if (entry.isFile()) {
      await mkdir(dirname(dest), { recursive: true });
      await cp(src, dest);
      count += 1;
    }
  }
  return count;
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function main(): Promise<void> {
  const dataDir = process.argv[2] ?? 'data';
  const result = await runMigrate(dataDir);
  process.stdout.write(`${result.lines.join('\n')}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
