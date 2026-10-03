import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createDataLayout } from '../../adapters/storage/layout.js';
import { addMember, findMember, readMembers, saveMembers } from './members.js';

/**
 * T-M1-01：Member 仓库（TDD §3.1/§6）。
 * members.json 缺失或损坏时按空名单处理（容错口径），坏条目逐条剔除。
 */

const created: string[] = [];

async function makeLayout() {
  const root = await mkdtemp(path.join(tmpdir(), 'bv-members-'));
  created.push(root);
  return createDataLayout(root);
}

/** 直接落一个损坏的 members.json（先建出目录） */
async function seedMembersFile(
  layout: ReturnType<typeof createDataLayout>,
  roomId: string,
  raw: string,
) {
  const file = layout.membersFile(roomId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, raw, 'utf8');
}

afterAll(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('readMembers（容错口径）', () => {
  it('members.json 缺失（未有人进房）→ 空数组', async () => {
    const layout = await makeLayout();
    expect(await readMembers(layout, 'room-1')).toEqual([]);
  });

  it('v1 信封缺 members 字段（不是数组）→ 空数组，不抛错', async () => {
    const layout = await makeLayout();
    await seedMembersFile(layout, 'room-1', '{"schemaVersion":1}');
    expect(await readMembers(layout, 'room-1')).toEqual([]);
  });

  it('坏条目逐条剔除，合法条目保留', async () => {
    const layout = await makeLayout();
    const good = { id: 'm_ok', name: '阿珂', role: 'player', joinedAt: '2026-09-25T04:00:00.000Z' };
    await seedMembersFile(
      layout,
      'room-1',
      JSON.stringify({ schemaVersion: 1, members: [good, { junk: true }, 'not-an-object'] }),
    );

    const members = await readMembers(layout, 'room-1');
    expect(members).toHaveLength(1);
    expect(members[0]?.id).toBe('m_ok');
  });
});

describe('addMember / findMember / saveMembers（T-M1-03 进房名册）', () => {
  it('addMember：生成 m_ 前缀 id 与 ISO 时间，落盘可读回', async () => {
    const layout = await makeLayout();

    const member = await addMember(layout, 'room-1', { name: '调查员·阿珂', role: 'player' });

    expect(member.id).toMatch(/^m_/);
    expect(member.role).toBe('player');
    expect(Number.isNaN(Date.parse(member.joinedAt))).toBe(false);

    const members = await readMembers(layout, 'room-1');
    expect(members).toHaveLength(1);
    expect(members[0]?.id).toBe(member.id);
  });

  it('findMember：命中返回成员，未命中返回 null', async () => {
    const layout = await makeLayout();
    const member = await addMember(layout, 'room-1', { name: 'KP', role: 'host' });

    expect((await findMember(layout, 'room-1', member.id))?.name).toBe('KP');
    expect(await findMember(layout, 'room-1', 'm_nope')).toBeNull();
  });

  it('saveMembers 整文件覆写（v1 单进程串行写）', async () => {
    const layout = await makeLayout();
    const a = await addMember(layout, 'room-1', { name: 'A', role: 'player' });
    const b = await addMember(layout, 'room-1', { name: 'B', role: 'observer' });

    await saveMembers(layout, 'room-1', [b, a]);

    const members = await readMembers(layout, 'room-1');
    expect(members.map((m) => m.id)).toEqual([b.id, a.id]);
  });
});

/**
 * 并发回归（2026-09-25 代码审查修复）：两玩家同时进房曾触发读改写竞态，
 * 后写的覆盖先写的，members.json 永久丢成员且不可自愈。
 */
describe('addMember 并发安全', () => {
  it('12 人同时进房不丢成员', async () => {
    const layout = await makeLayout();

    const added = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        addMember(layout, 'room-1', { name: `玩家${i}`, role: 'player' }),
      ),
    );

    const members = await readMembers(layout, 'room-1');
    expect(members).toHaveLength(12);
    expect(members.map((m) => m.id).sort()).toEqual(added.map((m) => m.id).sort());
  });
});
