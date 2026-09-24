import { mkdir, open, readFile, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { maybeCrashAfterWrite } from './crash-hook.js';

/**
 * JSONL 追加存储（T-M0-03，TDD §6 / NFR-06 写前持久化）。
 *
 * append 语义：序列化为完整一行 → write → fsync，返回即已落盘。
 * WAP 不变式（TC-FR-02-001）：凡已广播的消息必已 append 返回（先落盘后广播）。
 * readAll 逐行解析，坏行（非法 JSON）跳过并计数（TC-NFR-06-002）；
 * 空行忽略不计；文件不存在视为空（首次开团）。
 */
export interface JsonlReadResult {
  records: unknown[];
  badLines: number;
}

export class JsonlStore {
  private handle: FileHandle | null = null;

  constructor(private readonly filePath: string) {}

  /** 追加一条记录（写前持久化：返回时已 fsync） */
  async append(entry: unknown): Promise<void> {
    if (entry === undefined) {
      throw new TypeError('JsonlStore.append 不接受 undefined（避免写入残缺行）');
    }
    const handle = await this.ensureOpen();
    await handle.write(`${JSON.stringify(entry)}\n`, null, 'utf8');
    await handle.sync();
    maybeCrashAfterWrite();
  }

  /** 全量读取。坏行跳过并计数，不抛错 */
  async readAll(): Promise<JsonlReadResult> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { records: [], badLines: 0 };
      }
      throw err;
    }

    const records: unknown[] = [];
    let badLines = 0;
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try {
        records.push(JSON.parse(line) as unknown);
      } catch {
        badLines += 1;
      }
    }
    return { records, badLines };
  }

  /** 关闭句柄（进程优雅退出时调用） */
  async close(): Promise<void> {
    if (this.handle) {
      const handle = this.handle;
      this.handle = null;
      await handle.close();
    }
  }

  private async ensureOpen(): Promise<FileHandle> {
    if (!this.handle) {
      await mkdir(dirname(this.filePath), { recursive: true });
      this.handle = await open(this.filePath, 'a');
    }
    return this.handle;
  }
}
