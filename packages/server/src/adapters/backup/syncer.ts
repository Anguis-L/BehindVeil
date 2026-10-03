import { createHash } from 'node:crypto';
import { copyFile, mkdir, open, readdir, rename, rm, stat, truncate } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { JsonStore } from '../storage/json-store.js';
import type { DataLayout } from '../storage/layout.js';

/**
 * 热备增量同步器（T-M10-02，FR-31 / ADR-3-04，设计 §5.2）。
 *
 * `AIDLE_BACKUP_DIR` 配置后定时增量同步到备份目录：
 * - JSONL（messages/audit-dice/…）按字节偏移续传：游标记录 {offset, mtimeMs, size}，
 *   只追加新增字节；崩溃中断后续传（备份比游标长时先截断到游标再续，幂等）；
 * - 小文件（JSON/YAML/资源）mtime+size 快路命中跳过，否则 sha256 比对，不同才整份原子复制；
 * - 源删除镜像删除；游标 `data/index/backup-cursor.json` 原子写（每轮至多一次）。
 *
 * 铁律（ADR-03 文件即真相的延伸）：同步器**只读源文件**，不 import 房间串行队列，
 * 不参与任何业务写路径——对主链路的影响 = 一次目录扫描 + 少量文件读（fsync p99 增量 <5ms 的预算见设计 §5.1）。
 */

export interface BackupSyncerOptions {
  readonly dataDir: string;
  readonly backupDir: string;
  readonly layout: DataLayout;
  /** 同步周期 ms（默认 60s，ADR-3-04） */
  readonly intervalMs?: number;
  /** 周期结束后的摘要日志口（组装根注入 app.log） */
  readonly onCycle?: (summary: SyncReport) => void;
}

export interface SyncReport {
  readonly scanned: number;
  /** 整份复制的文件数 */
  readonly copied: number;
  /** 偏移续传的 JSONL 数 */
  readonly appended: number;
  /** 镜像删除数 */
  readonly removed: number;
  readonly skipped: number;
  readonly bytesAppended: number;
}

interface CursorEntry {
  offset: number;
  mtimeMs: number;
  size: number;
}

type Cursor = Record<string, CursorEntry>;

const DEFAULT_INTERVAL_MS = 60_000;

export class BackupSyncer {
  private readonly cursorStore: JsonStore;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private syncing = false;
  private stopped = false;

  constructor(private readonly opts: BackupSyncerOptions) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.cursorStore = new JsonStore(opts.layout.backupCursorFile);
    // 防自我嵌套：备份目录在 data/ 内部会把备份再备份（跨盘符时 relative 返回绝对路径，不算内部）
    const rel = relative(resolve(opts.dataDir), resolve(opts.backupDir));
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
      throw new Error(`AIDLE_BACKUP_DIR 不能位于 data/ 内部（${opts.backupDir}）：会自我嵌套同步`);
    }
  }

  /** 启动定时同步（首个周期立即执行） */
  start(): void {
    if (this.timer) return;
    this.stopped = false;
    void this.runCycle();
    this.timer = setInterval(() => void this.runCycle(), this.intervalMs);
  }

  /** 停止定时器并等待在途周期结束（优雅退出用） */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    while (this.syncing) {
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /** 执行一轮完整同步（测试与 CLI 直跑入口；定时器内亦走此处） */
  async syncOnce(): Promise<SyncReport> {
    const cursor = await this.loadCursor();
    const seen = new Set<string>();
    const report = {
      scanned: 0,
      copied: 0,
      appended: 0,
      removed: 0,
      skipped: 0,
      bytesAppended: 0,
    };

    await mkdir(this.opts.backupDir, { recursive: true });
    for (const file of await this.walkSource()) {
      const sourceStat = await stat(file.absolutePath);
      seen.add(file.relativePath);
      report.scanned += 1;

      if (file.relativePath.endsWith('.jsonl')) {
        const delta = await this.syncJsonl(file, sourceStat, cursor);
        if (delta.action === 'appended') {
          report.appended += 1;
          report.bytesAppended += delta.bytes;
        } else if (delta.action === 'copied') report.copied += 1;
        else report.skipped += 1;
        continue;
      }

      const outcome = await this.syncWholeFile(file, sourceStat, cursor);
      if (outcome === 'copied') report.copied += 1;
      else report.skipped += 1;
    }

    // 源侧已删除 → 镜像删除备份与游标条目
    for (const relPath of Object.keys(cursor)) {
      if (seen.has(relPath)) continue;
      await rm(join(this.opts.backupDir, relPath), { force: true });
      delete cursor[relPath];
      report.removed += 1;
    }

    await this.cursorStore.write(cursor);
    return report;
  }

  private async runCycle(): Promise<void> {
    if (this.syncing || this.stopped) return;
    this.syncing = true;
    try {
      const report = await this.syncOnce();
      this.opts.onCycle?.(report);
    } catch (err) {
      // 同步失败不阻断主链路：留待下一周期重试（源文件毫发无损）
      console.warn(
        `[backup] 同步失败（下一周期重试）：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.syncing = false;
    }
  }

  private async loadCursor(): Promise<Cursor> {
    const raw = (await this.cursorStore.read().catch(() => null)) as Cursor | null;
    return raw !== null && typeof raw === 'object' ? raw : {};
  }

  /**
   * JSONL 偏移续传。返回动作类型：
   * - 'copied'：游标缺失/源回退/备份与游标不符 → 整份重建；
   * - 'appended'：从游标偏移追加新增字节（备份超长先截断——崩溃续传的幂等保证）；
   * - 'skipped'：源无增长。
   */
  private async syncJsonl(
    file: SourceFile,
    sourceStat: { size: number; mtimeMs: number },
    cursor: Cursor,
  ): Promise<{ action: 'copied' | 'appended' | 'skipped'; bytes: number }> {
    const entry = cursor[file.relativePath];
    const backupPath = join(this.opts.backupDir, file.relativePath);
    const backupSize = await fileSizeOf(backupPath);

    if (entry === undefined || sourceStat.size < entry.offset || backupSize !== entry.offset) {
      await copyFileAtomic(file.absolutePath, backupPath);
      cursor[file.relativePath] = {
        offset: sourceStat.size,
        mtimeMs: sourceStat.mtimeMs,
        size: sourceStat.size,
      };
      return { action: 'copied', bytes: sourceStat.size };
    }
    if (sourceStat.size === entry.offset) {
      cursor[file.relativePath] = { ...entry, mtimeMs: sourceStat.mtimeMs, size: sourceStat.size };
      return { action: 'skipped', bytes: 0 };
    }

    // 增量：读 [offset, size) 追加到备份（备份超长先截断到游标，等价于崩溃后续传）
    if (backupSize > entry.offset) {
      await truncate(backupPath, entry.offset);
    }
    const chunk = await readRange(file.absolutePath, entry.offset, sourceStat.size);
    await mkdir(dirname(backupPath), { recursive: true });
    const handle = await open(backupPath, 'a');
    try {
      await handle.write(chunk);
      await handle.sync();
    } finally {
      await handle.close();
    }
    cursor[file.relativePath] = {
      offset: sourceStat.size,
      mtimeMs: sourceStat.mtimeMs,
      size: sourceStat.size,
    };
    return { action: 'appended', bytes: chunk.length };
  }

  /** 小文件整份同步：mtime+size 快路 → sha256 比对 → 不同才原子复制 */
  private async syncWholeFile(
    file: SourceFile,
    sourceStat: { size: number; mtimeMs: number },
    cursor: Cursor,
  ): Promise<'copied' | 'skipped'> {
    const entry = cursor[file.relativePath];
    const backupPath = join(this.opts.backupDir, file.relativePath);

    if (
      entry !== undefined &&
      entry.size === sourceStat.size &&
      entry.mtimeMs === sourceStat.mtimeMs
    ) {
      return 'skipped';
    }

    const sourceHash = await hashFile(file.absolutePath);
    const backupHash = await hashFile(backupPath);
    if (sourceHash !== null && sourceHash === backupHash) {
      cursor[file.relativePath] = { offset: 0, mtimeMs: sourceStat.mtimeMs, size: sourceStat.size };
      return 'skipped';
    }

    await copyFileAtomic(file.absolutePath, backupPath);
    cursor[file.relativePath] = { offset: 0, mtimeMs: sourceStat.mtimeMs, size: sourceStat.size };
    return 'copied';
  }

  /** 递归列出 data/ 下被跟踪文件（相对路径为游标键） */
  private async walkSource(): Promise<SourceFile[]> {
    const files: SourceFile[] = [];
    const skipDirs = new Set([resolve(this.opts.layout.indexDir)]);
    await walk(resolve(this.opts.dataDir), '', files, skipDirs);
    return files;

    async function walk(
      dir: string,
      rel: string,
      out: SourceFile[],
      skip: Set<string>,
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
          if (skip.has(resolve(abs)) || entry.name.startsWith('backup-pre-migrate-')) continue;
          await walk(abs, relPath, out, skip);
        } else if (entry.isFile()) {
          out.push({ absolutePath: abs, relativePath: relPath });
        }
      }
    }
  }
}

interface SourceFile {
  readonly absolutePath: string;
  readonly relativePath: string;
}

/** 整份原子复制：备份目录内 tmp + rename，任一时刻备份侧只见完整文件 */
async function copyFileAtomic(src: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.bak-tmp`;
  await copyFile(src, tmp);
  await rename(tmp, dest);
}

async function fileSizeOf(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch {
    return -1; // 备份缺失
  }
}

async function readRange(file: string, start: number, end: number): Promise<Buffer> {
  const length = end - start;
  if (length <= 0) return Buffer.alloc(0);
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function hashFile(file: string): Promise<string | null> {
  try {
    const handle = await open(file, 'r');
    try {
      const hash = createHash('sha256');
      const buffer = Buffer.alloc(1024 * 1024);
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead));
      }
      return hash.digest('hex');
    } finally {
      await handle.close();
    }
  } catch {
    return null; // 备份缺失等
  }
}
