import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { maybeCrashAfterWrite } from './crash-hook.js';

/**
 * 按文件路径的串行队列（2026-09-25 代码审查修复）。
 *
 * 原实现有两个并发缺陷，同一把锁一并解决：
 * 1. 临时文件名固定为 `<path>.tmp` —— 两次并发写互相覆盖同一个 tmp，且 rename 后
 *    另一条流的 rename 会失败或把旧内容盖回去；
 * 2. 调用方的「读 → 改 → 写」（如 addMember）跨多个 await，两条流同时读到旧值，
 *    后写的覆盖先写的，造成丢更新且文件永久损坏（不可自愈）。
 *
 * 因此：所有读写操作按文件路径串行化，并提供 `update()` 把读改写整段关进锁内。
 * 锁是进程内的（v1 单进程部署，NFR-02），不跨进程。
 */
const fileQueues = new Map<string, Promise<unknown>>();

function withFileLock<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const previous = fileQueues.get(filePath) ?? Promise.resolve();
  // 前序失败不阻塞后续（与网关消息主链路一致的口径）
  const result = previous.then(task, task);
  const settled = result.catch(() => undefined);
  fileQueues.set(filePath, settled);
  void settled.then(() => {
    if (fileQueues.get(filePath) === settled) fileQueues.delete(filePath);
  });
  return result;
}

/**
 * JSON 快照存储（T-M0-03，TDD §6 / CODING_STANDARDS §2.3）。
 *
 * 原子写：写带唯一后缀的临时文件 → fsync → rename 覆盖。任一时刻磁盘上都存在完整的
 * 旧版或新版，中断不产生半文件（TC-NFR-06-003/006：故障注入点位于 rename 前）。
 * 落盘为缩进 JSON，便于 Host 手编（D-01 synopsis / D-08 世界书工作流）。
 */
export class JsonStore {
  constructor(private readonly filePath: string) {}

  async write(value: unknown): Promise<void> {
    return withFileLock(this.filePath, () => this.writeUnlocked(value));
  }

  /** 文件不存在返回 null；JSON 损坏向上抛（由调用方决定告警或降级） */
  async read(): Promise<unknown | null> {
    return withFileLock(this.filePath, () => this.readUnlocked());
  }

  /**
   * 读改写（并发安全）：整段在同一把文件锁内完成，杜绝「两流读到同一旧值」的丢更新。
   * `mutate` 必须是同步纯变换（锁内不应再叠加别的 IO）。
   */
  async update<T>(mutate: (current: unknown | null) => T): Promise<T> {
    return withFileLock(this.filePath, async () => {
      const next = mutate(await this.readUnlocked());
      await this.writeUnlocked(next);
      return next;
    });
  }

  private async writeUnlocked(value: unknown): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    // 唯一后缀：并发流各自写各自的临时文件，不再互相踩踏
    const tmpPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const handle = await open(tmpPath, 'w');
      try {
        await handle.write(JSON.stringify(value, null, 2), null, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      maybeCrashAfterWrite();
      await rename(tmpPath, this.filePath);
    } catch (err) {
      await rm(tmpPath, { force: true });
      throw err;
    }
  }

  private async readUnlocked(): Promise<unknown | null> {
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
