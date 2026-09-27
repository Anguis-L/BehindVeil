import { mkdtemp, open, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { JsonStore } from './json-store.js';

/**
 * T-M0-03：JsonStore（tmp + rename 原子写，TDD §6）。
 * 对应 TC-NFR-06-003（中断后不出现半文件）与 TC-NFR-06-006（state.json 同机制）。
 */

const created: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'bv-json-'));
  created.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * node:fs 与 node:fs/promises 都不导出 FileHandle 类，要 spy 它的 `sync` 只能从实例反查原型。
 */
async function spyOnFsync(): Promise<ReturnType<typeof vi.spyOn>> {
  const probe = await open(path.join(await makeTmpDir(), 'probe.json'), 'a');
  const proto = Object.getPrototypeOf(probe) as { sync(): Promise<void> };
  await probe.close();
  return vi.spyOn(proto, 'sync');
}

describe('JsonStore 原子写', () => {
  it('写入后可原样读回', async () => {
    const dir = await makeTmpDir();
    const store = new JsonStore(path.join(dir, 'session.json'));

    await store.write({ id: 'ses_1', stateBoardVersion: 2 });

    expect(await store.read()).toEqual({ id: 'ses_1', stateBoardVersion: 2 });
  });

  it('落盘内容可被标准 JSON 解析器读取（兼容性：备份=复制目录）', async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, 'room.json');
    await new JsonStore(file).write({ id: 'r1', memberLimit: 8 });

    const raw = await readFile(file, 'utf8');
    expect(JSON.parse(raw)).toEqual({ id: 'r1', memberLimit: 8 });
  });

  it('覆盖写后读到的是新内容，永不出现半文件', async () => {
    const dir = await makeTmpDir();
    const store = new JsonStore(path.join(dir, 'state.json'));

    await store.write({ version: 1, scene: { name: '书房' } });
    await store.write({ version: 2, scene: { name: '阁楼' } });

    expect(await store.read()).toEqual({ version: 2, scene: { name: '阁楼' } });
  });

  it('写入完成后目录内不残留临时文件', async () => {
    const dir = await makeTmpDir();
    await new JsonStore(path.join(dir, 'session.json')).write({ id: 'ses_1' });

    const entries = await readdir(dir);
    expect(entries).toEqual(['session.json']);
  });

  /**
   * 原子写的回归锁：临时文件 fsync 过再 rename，才算「中断不产生半文件」。
   * 少了这步 fsync，rename 可能赶在落盘前完成，崩溃后新文件是空的。
   */
  it('write 在 rename 前 fsync 了临时文件', async () => {
    const dir = await makeTmpDir();
    const store = new JsonStore(path.join(dir, 'session.json'));
    const syncSpy = await spyOnFsync();
    try {
      await store.write({ version: 1 });

      expect(syncSpy, 'rename 前必须 fsync 临时文件').toHaveBeenCalled();
    } finally {
      syncSpy.mockRestore();
    }
  });

  it('文件不存在时 read 返回 null（尚未开团）', async () => {
    const dir = await makeTmpDir();
    expect(await new JsonStore(path.join(dir, 'missing.json')).read()).toBeNull();
  });

  it('嵌套路径自动创建父目录', async () => {
    const dir = await makeTmpDir();
    const store = new JsonStore(path.join(dir, 'rooms', 'r1', 'room.json'));

    await store.write({ id: 'r1' });

    expect(await store.read()).toEqual({ id: 'r1' });
  });
});

/**
 * 并发修复回归（2026-09-25 代码审查）：
 * 原实现临时文件名固定 + 无锁，并发写会互相踩踏；调用方跨 await 的读改写会丢更新。
 */
describe('JsonStore 并发安全', () => {
  it('并发写 50 次：结果是某一次的完整值，且不残留临时文件', async () => {
    const dir = await makeTmpDir();
    const store = new JsonStore(path.join(dir, 'state.json'));

    await Promise.all(Array.from({ length: 50 }, (_, i) => store.write({ version: i })));

    const raw = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8')) as {
      version: number;
    };
    expect(raw.version).toBeGreaterThanOrEqual(0);
    expect(raw.version).toBeLessThan(50);
    expect(await readdir(dir)).toEqual(['state.json']);
  });

  it('update 的读改写不丢更新（并发 20 次累加）', async () => {
    const dir = await makeTmpDir();
    const store = new JsonStore(path.join(dir, 'counter.json'));

    await Promise.all(
      Array.from({ length: 20 }, () =>
        store.update((current) => {
          const n = (current as { n: number } | null)?.n ?? 0;
          return { n: n + 1 };
        }),
      ),
    );

    expect(await store.read()).toEqual({ n: 20 });
  });

  it('update 与并发 write 交错也串行生效（后到者覆盖，不产生半写）', async () => {
    const dir = await makeTmpDir();
    const store = new JsonStore(path.join(dir, 'room.json'));

    await Promise.all([
      store.update((current) => ({ ...(current as object | null), fromUpdate: true })),
      store.write({ fromWrite: true }),
    ]);

    const result = (await store.read()) as Record<string, boolean>;
    expect(Object.keys(result)).toHaveLength(1);
    expect(result.fromUpdate === true || result.fromWrite === true).toBe(true);
  });
});
