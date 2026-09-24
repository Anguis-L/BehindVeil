import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { JsonlStore } from './jsonl-store.js';

/**
 * T-M0-03：JsonlStore（append + fsync 写前持久化，TDD §6）。
 * 对应 TC-NFR-06-001（崩溃 0 丢失）与 TC-NFR-06-002（坏行容错）。
 */

const created: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'bv-jsonl-'));
  created.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('JsonlStore.append（写前持久化 WAP）', () => {
  it('追加一条即落盘为完整行（以换行收尾）', async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, 'messages.jsonl');
    const store = new JsonlStore(file);

    await store.append({ seq: 1, content: '第一条' });

    const raw = await readFile(file, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.split('\n').filter(Boolean)).toHaveLength(1);
    expect(JSON.parse(raw.trim())).toMatchObject({ seq: 1, content: '第一条' });
  });

  it('append 返回后数据已可回读（先落盘再广播的前提）', async () => {
    const dir = await makeTmpDir();
    const store = new JsonlStore(path.join(dir, 'messages.jsonl'));

    await store.append({ seq: 1 });

    const result = await store.readAll();
    expect(result.records).toHaveLength(1);
    expect(result.badLines).toBe(0);
  });

  it('追加顺序与写入顺序一致（seq 单调的前提）', async () => {
    const dir = await makeTmpDir();
    const store = new JsonlStore(path.join(dir, 'messages.jsonl'));

    for (let i = 1; i <= 50; i += 1) {
      await store.append({ seq: i });
    }

    const result = await store.readAll();
    expect(result.records).toHaveLength(50);
    expect(result.records[0]).toMatchObject({ seq: 1 });
    expect(result.records[49]).toMatchObject({ seq: 50 });
  });

  it('父目录不存在时自动创建', async () => {
    const dir = await makeTmpDir();
    const store = new JsonlStore(path.join(dir, 'rooms', 'r1', 'sessions', 's1', 'messages.jsonl'));

    await store.append({ seq: 1 });

    const result = await store.readAll();
    expect(result.records).toHaveLength(1);
  });

  // 每条 append 都带 fsync，Windows 上单条约数毫秒，500 条远超默认 5s 预算
  it('500 条连续追加全部可读（TC-NFR-06-001 的无故障基线）', async () => {
    const dir = await makeTmpDir();
    const store = new JsonlStore(path.join(dir, 'messages.jsonl'));

    for (let i = 1; i <= 500; i += 1) {
      await store.append({ seq: i, content: `第 ${i} 条` });
    }

    const result = await store.readAll();
    expect(result.records).toHaveLength(500);
    expect(result.badLines).toBe(0);
  }, 60_000);
});

describe('JsonlStore.readAll 坏行容错（TC-NFR-06-002）', () => {
  it('跳过非法 JSON 行并计数告警', async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, 'messages.jsonl');
    await writeFile(
      file,
      ['{"seq":1}', '{"seq":2', 'not-json-at-all', '{"seq":3}'].join('\n') + '\n',
      'utf8',
    );

    const result = await new JsonlStore(file).readAll();

    expect(result.badLines).toBe(2);
    expect(result.records).toHaveLength(2);
    expect(result.records[0]).toMatchObject({ seq: 1 });
    expect(result.records[1]).toMatchObject({ seq: 3 });
  });

  it('空行被忽略且不计为坏行', async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, 'messages.jsonl');
    await writeFile(file, '{"seq":1}\n\n\n{"seq":2}\n', 'utf8');

    const result = await new JsonlStore(file).readAll();

    expect(result.badLines).toBe(0);
    expect(result.records).toHaveLength(2);
  });

  it('文件不存在时返回空结果而不抛错（首次开团）', async () => {
    const dir = await makeTmpDir();
    const result = await new JsonlStore(path.join(dir, 'missing.jsonl')).readAll();

    expect(result.records).toEqual([]);
    expect(result.badLines).toBe(0);
  });

  it('末尾无换行的最后一行仍能被解析（写入被中断的边界）', async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, 'messages.jsonl');
    await writeFile(file, '{"seq":1}\n{"seq":2}', 'utf8');

    const result = await new JsonlStore(file).readAll();

    expect(result.records).toHaveLength(2);
    expect(result.badLines).toBe(0);
  });
});
