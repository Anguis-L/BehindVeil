import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
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
