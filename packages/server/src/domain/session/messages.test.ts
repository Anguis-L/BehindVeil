import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createDataLayout, type DataLayout } from '../../adapters/storage/layout.js';
import { JsonlStore } from '../../adapters/storage/jsonl-store.js';
import { appendMessage, readMessagesAfter, readMessagesPage } from './messages.js';
import type { Message } from '@behindveil/shared';

/**
 * T-M1-05/08/09：消息持久化与历史读取（TDD §6 NFR-06、决议 ④、D-10）。
 * WAP 不变式（appendMessage 返回即已 fsync）与坏行容错口径在此固化。
 */

const created: string[] = [];

async function makeLayout(): Promise<DataLayout> {
  const root = await mkdtemp(path.join(tmpdir(), 'bv-messages-'));
  created.push(root);
  return createDataLayout(root);
}

const roll = {
  expr: '1d100',
  rolls: [[42]],
  kept: [42],
  total: 42,
  audit: { seq: 'a-1', ts: '2026-09-25T04:00:00.000Z', rollId: 'roll-1' },
};

const msgs: Message[] = [
  {
    seq: 1,
    ts: '2026-09-25T04:00:01.000Z',
    sessionId: 's_1',
    type: 'ic',
    senderId: 'm_a',
    content: '开场',
  },
  {
    seq: 2,
    ts: '2026-09-25T04:00:02.000Z',
    sessionId: 's_1',
    type: 'ooc',
    senderId: 'm_a',
    content: '悄悄话',
    visibility: 'whisper',
    targetId: 'm_b',
  },
  {
    seq: 3,
    ts: '2026-09-25T04:00:03.000Z',
    sessionId: 's_1',
    type: 'dice',
    roll: { ...roll, audit: { ...roll.audit, rollId: 'roll-2' } },
    hidden: true,
  },
  {
    seq: 4,
    ts: '2026-09-25T04:00:04.000Z',
    sessionId: 's_1',
    type: 'system',
    subtype: 'join',
    content: '阿珂 加入了房间',
  },
  {
    seq: 5,
    ts: '2026-09-25T04:00:05.000Z',
    sessionId: 's_1',
    type: 'ic',
    senderId: 'm_b',
    content: '回应',
  },
];

afterAll(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('appendMessage（WAP：返回即已落盘）', () => {
  it('追加后可整读读回', async () => {
    const layout = await makeLayout();

    await appendMessage(layout, 'room-1', 's_1', msgs[0] as Message);
    await appendMessage(layout, 'room-1', 's_1', msgs[1] as Message);

    const { records, badLines } = await new JsonlStore(
      layout.messagesFile('room-1', 's_1'),
    ).readAll();
    expect(records).toHaveLength(2);
    expect(badLines).toBe(0);
  });
});

describe('readMessagesPage（T-M1-09 历史翻页，决议 ④）', () => {
  it('空会话：messages 为空、lastSeq=0', async () => {
    const layout = await makeLayout();
    const page = await readMessagesPage(layout, 'room-1', 's_1');
    expect(page.messages).toEqual([]);
    expect(page.lastSeq).toBe(0);
  });

  it('seq 降序（最新在前），lastSeq 取最大 seq', async () => {
    const layout = await makeLayout();
    for (const m of msgs) await appendMessage(layout, 'room-1', 's_1', m);

    const page = await readMessagesPage(layout, 'room-1', 's_1');

    expect(page.messages.map((m) => m.seq)).toEqual([5, 4, 3, 2, 1]);
    expect(page.lastSeq).toBe(5);
  });

  it('limit 截断；beforeSeq 向前翻页衔接处不丢不重', async () => {
    const layout = await makeLayout();
    for (const m of msgs) await appendMessage(layout, 'room-1', 's_1', m);

    const first = await readMessagesPage(layout, 'room-1', 's_1', { limit: 2 });
    expect(first.messages.map((m) => m.seq)).toEqual([5, 4]);

    const oldest = first.messages.at(-1)?.seq ?? 0;
    const second = await readMessagesPage(layout, 'room-1', 's_1', { limit: 2, beforeSeq: oldest });
    expect(second.messages.map((m) => m.seq)).toEqual([3, 2]);
  });

  it('excludeHidden 剔除暗骰（D-10：REST 历史默认不泄露），但 lastSeq 仍计入', async () => {
    const layout = await makeLayout();
    for (const m of msgs) await appendMessage(layout, 'room-1', 's_1', m);

    const page = await readMessagesPage(layout, 'room-1', 's_1', { excludeHidden: true });

    expect(page.messages.some((m) => m.type === 'dice' && m.hidden)).toBe(false);
    expect(page.lastSeq).toBe(5);
  });

  it('坏行跳过：不计入返回，也不计入 lastSeq', async () => {
    const layout = await makeLayout();
    for (const m of msgs.slice(0, 2)) await appendMessage(layout, 'room-1', 's_1', m);
    await appendFile(layout.messagesFile('room-1', 's_1'), '{broken json line\n', 'utf8');

    const page = await readMessagesPage(layout, 'room-1', 's_1');

    expect(page.messages.map((m) => m.seq)).toEqual([2, 1]);
    expect(page.lastSeq).toBe(2);
  });
});

describe('readMessagesAfter（T-M1-08 断线补发缺口）', () => {
  it('只返回 seq > afterSeq 的消息，按 seq 升序', async () => {
    const layout = await makeLayout();
    for (const m of msgs) await appendMessage(layout, 'room-1', 's_1', m);

    const missed = await readMessagesAfter(layout, 'room-1', 's_1', 2);

    expect(missed.map((m) => m.seq)).toEqual([3, 4, 5]);
  });

  it('无缺口时返回空数组', async () => {
    const layout = await makeLayout();
    await appendMessage(layout, 'room-1', 's_1', msgs[0] as Message);

    expect(await readMessagesAfter(layout, 'room-1', 's_1', 1)).toEqual([]);
  });
});
