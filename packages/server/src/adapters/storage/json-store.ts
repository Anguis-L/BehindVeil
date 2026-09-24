import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { maybeCrashAfterWrite } from './crash-hook.js';

/**
 * JSON 快照存储（T-M0-03，TDD §6 / CODING_STANDARDS §2.3）。
 *
 * 原子写：写 <path>.tmp → fsync → rename 覆盖。任一时刻磁盘上都存在完整的
 * 旧版或新版，中断不产生半文件（TC-NFR-06-003/006：故障注入点位于 rename 前）。
 * 落盘为缩进 JSON，便于 Host 手编（D-01 synopsis / D-08 世界书工作流）。
 */
export class JsonStore {
  constructor(private readonly filePath: string) {}

  async write(value: unknown): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    const handle = await open(tmpPath, 'w');
    try {
      await handle.write(JSON.stringify(value, null, 2), null, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    maybeCrashAfterWrite();
    await rename(tmpPath, this.filePath);
  }

  /** 文件不存在返回 null；JSON 损坏向上抛（由调用方决定告警或降级） */
  async read(): Promise<unknown | null> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    return JSON.parse(raw) as unknown;
  }
}
