import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Message } from '@behindveil/shared';
import { createDataLayout } from '../adapters/storage/layout.js';
import { GlobalIndex, indexEntryOf, rebuildGlobalIndex } from './global-index.js';

/**
 * 跨房间全局索引（v3 T-M11-05，FR-34）。
 *
 * 三条主线：① 索引行生成（含 system 无 senderId 的分支）；② 检索与房间过滤；
 * ③ 重建一致性——索引是派生数据，重建结果必须与逐条追加等价（这是它敢坏即弃的底气）。
 */

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bv-global-index-'));
  dirs.push(dir);
  return dir;
}

/** 按真实落盘形态写消息文件（重建器只读文件系统，目录要自己建） */
async function writeMessages(file: string, messages: Message[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, messages.map((m) => `${JSON.stringify(m)}\n`).join(''), 'utf8');
}

/**
 * 清理带超时竞速：沙箱的文件删除守卫会**挂起** rm（不是报错，是卡住），直接 await
 * 会让整条用例超时判红——而断言其实全过了。清理失败只留一点临时目录，划算。
 */
async function rmQuietly(dir: string): Promise<void> {
  await Promise.race([
    rm(dir, { recursive: true, force: true }).catch(() => undefined),
    new Promise((r) => setTimeout(r, 2_000)),
  ]);
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rmQuietly(dir);
});

const base = { seq: 1, ts: '2026-10-04T00:00:00.000Z', sessionId: 'ses_1' };

const ic: Message = { ...base, type: 'ic', senderId: 'mem_1', content: '我推开雾中的门' };
const systemMsg: Message = {
  ...base,
  seq: 2,
  type: 'system',
  subtype: 'notice',
  content: '本会话已达 20 条消息',
};
const dice: Message = {
  ...base,
  seq: 3,
  type: 'dice',
  roll: {
    expr: '1d100',
    rolls: [[42]],
    kept: [42],
    total: 42,
    audit: { seq: '1', ts: base.ts, rollId: 'roll_1' },
  },
  hidden: true,
};

describe('indexEntryOf：索引行生成', () => {
  it('ic 行带 senderId 与正文', () => {
    const entry = indexEntryOf('r_1', 'ses_1', ic);
    expect(entry).toEqual({
      roomId: 'r_1',
      sessionId: 'ses_1',
      seq: 1,
      type: 'ic',
      senderId: 'mem_1',
      ts: base.ts,
      content: '我推开雾中的门',
    });
  });

  it('system 消息无 senderId：落空串而不是 undefined（契约要求字符串）', () => {
    const entry = indexEntryOf('r_1', 'ses_1', systemMsg);
    expect(entry.senderId).toBe('');
    expect(entry.content).toBe('本会话已达 20 条消息');
  });

  it('dice 行取「骰式 = 结果」并保留暗骰标记（索引是 Host 视角完整版）', () => {
    const entry = indexEntryOf('r_1', 'ses_1', dice);
    expect(entry.content).toBe('1d100 = 42');
    expect(entry.hidden).toBe(true);
    // 引擎代掷（AI 检定骰）无 senderId → 空串
    expect(entry.senderId).toBe('');
  });
});

describe('GlobalIndex：追加与检索', () => {
  it('空查询返回空；子串匹配按 seq 降序', async () => {
    const dir = await tempDir();
    const layout = createDataLayout(dir);
    const index = new GlobalIndex(layout.globalIndexFile);

    await index.append(indexEntryOf('r_1', 'ses_1', ic));
    await index.append(indexEntryOf('r_1', 'ses_1', { ...ic, seq: 5, content: '雾中有灯塔' }));

    expect(await index.search('')).toEqual([]);
    const hits = await index.search('雾');
    expect(hits.map((h) => h.seq)).toEqual([5, 1]);
  });

  it('roomId 过滤：跨房间检索要能限定到单个团', async () => {
    const dir = await tempDir();
    const layout = createDataLayout(dir);
    const index = new GlobalIndex(layout.globalIndexFile);

    await index.append(indexEntryOf('r_1', 'ses_1', ic));
    await index.append(indexEntryOf('r_2', 'ses_9', { ...ic, seq: 2, content: '雾中灯塔' }));

    expect(await index.search('雾', { roomId: 'r_1' })).toHaveLength(1);
    // 注意括号：await 优先于下标，写成 await index.search()[0] 会去索引 Promise
    expect((await index.search('雾', { roomId: 'r_2' }))[0]?.roomId).toBe('r_2');
  });

  it('limit 截断与坏行容错：坏行跳过不计入命中，索引仍是可用状态', async () => {
    const dir = await tempDir();
    const layout = createDataLayout(dir);
    await mkdir(dirname(layout.globalIndexFile), { recursive: true });
    await writeFile(
      layout.globalIndexFile,
      `${JSON.stringify(indexEntryOf('r_1', 'ses_1', ic))}\n{bad json\n`,
      'utf8',
    );
    const index = new GlobalIndex(layout.globalIndexFile);
    const hits = await index.search('雾');
    expect(hits).toHaveLength(1);
  });
});

describe('rebuildGlobalIndex：重建等价于逐条追加', () => {
  it('索引删掉后重建，内容与逐条追加完全一致（派生数据的底气）', async () => {
    const dir = await tempDir();
    const layout = createDataLayout(dir);

    // 先按真实落盘形态写两份消息文件（两个房间各一会话）
    const messages = [ic, { ...ic, seq: 2, content: '灯塔在雾中闪了一下' }];
    await writeMessages(layout.messagesFile('r_1', 'ses_1'), messages);
    const other: Message = { ...ic, seq: 1, content: '另一团的雾' };
    await writeMessages(layout.messagesFile('r_2', 'ses_9'), [other]);

    // 逐条追加的参照组
    const reference = new GlobalIndex(join(dir, 'reference.jsonl'));
    for (const message of messages) {
      await reference.append(indexEntryOf('r_1', 'ses_1', message));
    }
    await reference.append(indexEntryOf('r_2', 'ses_9', other));
    const expected = await reference.search('雾');

    const result = await rebuildGlobalIndex(dir);
    expect(result).toEqual({ entries: 3, badLines: 0 });

    const rebuilt = new GlobalIndex(layout.globalIndexFile);
    expect(await rebuilt.search('雾')).toEqual(expected);
  });

  it('消息文件有坏行：如实上报，不静默吞掉', async () => {
    const dir = await tempDir();
    const layout = createDataLayout(dir);
    await mkdir(dirname(layout.messagesFile('r_1', 'ses_1')), { recursive: true });
    await writeFile(
      layout.messagesFile('r_1', 'ses_1'),
      `${JSON.stringify(ic)}\n{broken\n`,
      'utf8',
    );
    const result = await rebuildGlobalIndex(dir);
    expect(result.entries).toBe(1);
    expect(result.badLines).toBe(1);
  });

  it('重复 rebuild 是幂等的（先删后建，不叠加）', async () => {
    const dir = await tempDir();
    const layout = createDataLayout(dir);
    await writeMessages(layout.messagesFile('r_1', 'ses_1'), [ic]);

    await rebuildGlobalIndex(dir);
    const second = await rebuildGlobalIndex(dir);
    expect(second.entries).toBe(1);

    const lines = (await readFile(layout.globalIndexFile, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
  });
});
