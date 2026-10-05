import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, type WorldBookEntry } from '@behindveil/shared';
import { createDataLayout } from '../../adapters/storage/layout.js';
import { readRoomWorldBook, writeRoomWorldBook } from './store.js';

/**
 * 世界书编辑器读写（v3 T-M11-06，FR-35）。
 *
 * 编辑器让服务端第一次握有世界书写路径，因此这里守住三件事：
 * ① roundtrip（写进去能原样读回来）；② 落盘是带版本信封的，且**手编的裸
 * `{entries}` 仍然读得进**（不能因为编辑器落地就把手编用户挡在门外）；
 * ③ D-08 不变——结构错误拒绝落盘，语义隐患只告警。
 */

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bv-wb-store-'));
  dirs.push(dir);
  return dir;
}

/** 清理带超时竞速（沙箱 rm 会挂起，见 global-index.test.ts 同款说明） */
async function rmQuietly(dir: string): Promise<void> {
  await Promise.race([
    rm(dir, { recursive: true, force: true }).catch(() => undefined),
    new Promise((r) => setTimeout(r, 2_000)),
  ]);
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rmQuietly(dir);
});

/** 手编世界书是用户直接放文件：写测试夹具要自己建目录 */
async function writeFileAt(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
}

const entry: WorldBookEntry = {
  uid: 1,
  key: ['灯塔'],
  keysecondary: ['雾'],
  selectiveLogic: 0,
  content: '泊位边的长明灯。',
  position: 'before_char',
  order: 100,
  weight: 100,
  constant: false,
  disabled: false,
};

describe('世界书读写 roundtrip', () => {
  it('未写过世界书：读到空条目而不是报错（手编可选，D-08）', async () => {
    const dir = await tempDir();
    const layout = createDataLayout(dir);
    const result = await readRoomWorldBook(layout, 'r_1');
    expect(result.book.entries).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('写入后读回等价，落盘带 schemaVersion 信封（迁移管辖内）', async () => {
    const dir = await tempDir();
    const layout = createDataLayout(dir);

    const written = await writeRoomWorldBook(layout, 'r_1', { entries: [entry] });
    expect(written.warnings).toEqual([]);

    const raw = JSON.parse(await readFile(layout.worldbookFile('r_1'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(raw['schemaVersion']).toBe(SCHEMA_VERSION);
    expect(raw['entries']).toEqual([entry]);

    const read = await readRoomWorldBook(layout, 'r_1');
    expect(read.book.entries).toEqual([entry]);
  });

  it('手编的裸 {entries}（无版本字段）照样读得进——不强制先跑迁移', async () => {
    const dir = await tempDir();
    const layout = createDataLayout(dir);
    await writeFileAt(layout.worldbookFile('r_1'), JSON.stringify({ entries: [entry] }));

    const read = await readRoomWorldBook(layout, 'r_1');
    expect(read.book.entries).toEqual([entry]);
  });

  it('再次写入是覆盖而非追加（编辑器保存 = 全量替换）', async () => {
    const dir = await tempDir();
    const layout = createDataLayout(dir);
    await writeRoomWorldBook(layout, 'r_1', { entries: [entry, { ...entry, uid: 2 }] });
    await writeRoomWorldBook(layout, 'r_1', { entries: [entry] });

    const read = await readRoomWorldBook(layout, 'r_1');
    expect(read.book.entries).toHaveLength(1);
  });
});

describe('写入校验（D-08：结构拒绝，语义告警）', () => {
  it('uid 重复 → 拒绝落盘，且原文件不动', async () => {
    const dir = await tempDir();
    const layout = createDataLayout(dir);
    await writeRoomWorldBook(layout, 'r_1', { entries: [entry] });

    await expect(
      writeRoomWorldBook(layout, 'r_1', { entries: [entry, { ...entry, key: ['雾号'] }] }),
    ).rejects.toThrow(/uid 重复/);

    // 拒绝后磁盘内容仍是上一次保存的结果
    const read = await readRoomWorldBook(layout, 'r_1');
    expect(read.book.entries).toHaveLength(1);
  });

  it('at_depth 缺 depth → 拒绝落盘', async () => {
    const dir = await tempDir();
    const layout = createDataLayout(dir);
    await expect(
      writeRoomWorldBook(layout, 'r_1', {
        entries: [{ ...entry, position: 'at_depth', depth: undefined }],
      }),
    ).rejects.toThrow(/at_depth 必须提供 depth/);
  });

  it('非常驻且无关键词 → 放行但告警（扫描时永不命中，KP 自己判断）', async () => {
    const dir = await tempDir();
    const layout = createDataLayout(dir);
    const result = await writeRoomWorldBook(layout, 'r_1', {
      entries: [{ ...entry, key: [] }],
    });
    expect(result.warnings.join('\n')).toContain('永远不会命中');
  });

  it('读到的世界书结构不合法 → 载入时抛错（与 v1/v2 口径一致）', async () => {
    const dir = await tempDir();
    const layout = createDataLayout(dir);
    await writeFileAt(
      layout.worldbookFile('r_1'),
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, entries: [{ uid: 1 }] }),
    );
    await expect(readRoomWorldBook(layout, 'r_1')).rejects.toThrow(/世界书校验未通过/);
  });
});
