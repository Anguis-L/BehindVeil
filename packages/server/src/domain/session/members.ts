import { MemberSchema, type Member, type MemberRole } from '@behindveil/shared';
import { JsonStore } from '../../adapters/storage/json-store.js';
import type { DataLayout } from '../../adapters/storage/layout.js';
import { generateMemberId } from './ids.js';

/**
 * Member 仓库（T-M1-01，TDD §3.1/§6）：members.json 整文件读写。
 * v1 单进程串行写（REST/网关都在同一事件循环），无并发竞争窗口。
 */

/** members.json 缺失（未有人进房）或损坏时按空名单处理（损坏告警由启动恢复覆盖 room 级） */
export async function readMembers(layout: DataLayout, roomId: string): Promise<Member[]> {
  const json = await new JsonStore(layout.membersFile(roomId)).read();
  if (json === null) return [];
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
  const members = await readMembers(layout, roomId);
  const member: Member = {
    id: generateMemberId(),
    name: input.name,
    role: input.role,
    joinedAt: new Date().toISOString(),
  };
  members.push(member);
  await saveMembers(layout, roomId, members);
  return member;
}
