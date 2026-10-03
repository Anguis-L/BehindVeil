import { readFile } from 'node:fs/promises';
import { MIGRATORS, readSchemaVersion, type ArchiveKind } from '@behindveil/shared';
import { listArchiveFiles } from './archive-walk.js';

/**
 * 启动版本门禁（T-M10-01，FR-30「宁可拒绝，不静默猜」）。
 *
 * createServer 在启动恢复前跑一遍：任何存档版本 ≠ 当前版本（含版本字段非法）即抛
 * MigrationRequiredError，明示 aidle-migrate 命令。JSON 解析失败的文件不在此拦截
 * ——那是启动恢复器的既有辖区（跳过 + 告警，v1/v2 行为不劣化）。
 */

export interface ArchiveVersionIssue {
  readonly relativePath: string;
  readonly kind: ArchiveKind;
  /** 'invalid' = schemaVersion 字段非法（非整数等） */
  readonly found: number | 'invalid';
  readonly expected: number;
}

export class MigrationRequiredError extends Error {
  constructor(public readonly issues: readonly ArchiveVersionIssue[]) {
    super(formatMigrationMessage(issues));
    this.name = 'MigrationRequiredError';
  }
}

export interface ArchiveVersionScan {
  /** 版本合规的存档数（缺失文件不计） */
  readonly checked: number;
  readonly issues: ArchiveVersionIssue[];
}

export async function scanArchiveVersions(dataDir: string): Promise<ArchiveVersionScan> {
  const files = await listArchiveFiles(dataDir);
  const issues: ArchiveVersionIssue[] = [];
  let checked = 0;

  for (const file of files) {
    let raw: string;
    try {
      raw = await readFile(file.absolutePath, 'utf8');
    } catch {
      continue; // 文件不存在（枚举只列路径不 stat）——合法空缺
    }
    let doc: unknown;
    try {
      doc = JSON.parse(raw) as unknown;
    } catch {
      continue; // JSON 损坏：启动恢复器的辖区（跳过 + 告警），非版本问题
    }
    let version: number;
    try {
      version = readSchemaVersion(doc);
    } catch {
      issues.push({
        relativePath: file.relativePath,
        kind: file.kind,
        found: 'invalid',
        expected: MIGRATORS[file.kind].currentVersion,
      });
      continue;
    }
    checked += 1;
    const expected = MIGRATORS[file.kind].currentVersion;
    if (version !== expected) {
      issues.push({ relativePath: file.relativePath, kind: file.kind, found: version, expected });
    }
  }
  return { checked, issues };
}

/** 版本全合规则静默通过；有任何不符即抛（启动中止） */
export async function assertArchivesUpToDate(dataDir: string): Promise<ArchiveVersionScan> {
  const scan = await scanArchiveVersions(dataDir);
  if (scan.issues.length > 0) throw new MigrationRequiredError(scan.issues);
  return scan;
}

function formatMigrationMessage(issues: readonly ArchiveVersionIssue[]): string {
  const lines = issues.map((issue) => {
    const found = issue.found === 'invalid' ? '版本字段非法' : `版本 ${issue.found}`;
    return `  - ${issue.relativePath}：${found}，期望 ${issue.expected}`;
  });
  return [
    '存档版本与当前服务端不符，拒绝启动（FR-30：宁可拒绝，不静默猜）：',
    ...lines,
    '请先迁移存档：pnpm aidle-migrate（自动整目录备份 data/ → data/backup-pre-migrate-<时间戳>/ 后原地升级）',
  ].join('\n');
}
