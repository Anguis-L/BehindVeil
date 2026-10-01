import { MemberSchema, type Member, type MemberRole } from '@behindveil/shared';
import { JsonStore } from '../../adapters/storage/json-store.js';
import type { DataLayout } from '../../adapters/storage/layout.js';
import { generateMemberId } from './ids.js';

/**
 * Member 仓库（T-M1-01，TDD §3.1/§6）：members.json 整文件读写。
 *
 * 并发：同一进程内多玩家同时进房会并发触发 addMember（跨 await 的读改写），
 * 该操作已收进 JsonStore.update() 的文件锁内；其余调用只读或整写，无需额外保护。
 */

/** members.json 缺失（未有人进房）或损坏时按空名单处理（损坏告警由启动恢复覆盖 room 级） */
export async function readMembers(layout: DataLayout, roomId: string): Promise<Member[]> {
  const json = await new JsonStore(layout.membersFile(roomId)).read();
  return parseMembers(json);
}

/** 逐条过 Schema，坏条目跳过（与 readMembers 容错口径一致） */
function parseMembers(json: unknown | null): Member[] {
  if (!Array.isArray(json)) return [];
  const members: Member[] = [];
  for (const item of json) {
    const parsed = MemberSchema.safeParse(item);
    if (parsed.success) members.push(parsed.data);
  }
  return members;
}

export async function saveMembers(
  layout: DataLayout,
  roomId: string,
  members: Member[],
): Promise<void> {
  await new JsonStore(layout.membersFile(roomId)).write(members);
}

export async function findMember(
  layout: DataLayout,
  roomId: string,
  memberId: string,
): Promise<Member | null> {
  const members = await readMembers(layout, roomId);
  return members.find((m) => m.id === memberId) ?? null;
}

export interface AddMemberInput {
  name: string;
  role: MemberRole;
}

export async function addMember(
  layout: DataLayout,
  roomId: string,
  input: AddMemberInput,
): Promise<Member> {
  const member: Member = {
    id: generateMemberId(),
    name: input.name,
    role: input.role,
    joinedAt: new Date().toISOString(),
  };
  // 读改写整段进锁：两玩家同时进房也不会互相覆盖（2026-09-25 代码审查修复）
  await new JsonStore(layout.membersFile(roomId)).update((current) => {
    const members = parseMembers(current);
    members.push(member);
    return members;
  });
  return member;
}

/** 成员角色更新（T-M8-06 Host 转让）：读改写进 JsonStore 文件锁，与 addMember 同一并发口径 */
export async function updateMemberRole(
  layout: DataLayout,
  roomId: string,
  memberId: string,
  role: MemberRole,
): Promise<void> {
  await new JsonStore(layout.membersFile(roomId)).update((current) => {
    const members = parseMembers(current);
    return members.map((m) => (m.id === memberId ? { ...m, role } : m));
  });
}
