import { PCSheetSchema } from '@behindveil/shared';
import { z } from 'zod';
import { ArchiveJsonStore } from '../../adapters/storage/archive-store.js';
import type { DataLayout } from '../../adapters/storage/layout.js';

/**
 * 房间级 PC 声明（T-M5-04，SDD §5.1 开团流程：进房 → 声明 PC → Host 开新 Session）。
 *
 * 声明落 `rooms/<roomId>/roster.json`，key = memberId（与状态板 pcs 键一致，TDD §3.7）；
 * 开团（createSession）时整表装配进状态板初始 pcs。声明是开团前的准备态，
 * 与会话级状态板分离：换会话不重声明，撤销/重声明不影响已开团的会话。
 */

export const DeclaredPcSchema = z.object({
  sheet: PCSheetSchema,
  /** card=从卡库玩家卡的 pcSheet 装配；manual=Host 速建表直填 */
  source: z.enum(['card', 'manual']),
  /** source=card 时的卡库文件名（CardEntry.id） */
  cardId: z.string().optional(),
});
export type DeclaredPc = z.infer<typeof DeclaredPcSchema>;

export const RoomRosterSchema = z.object({
  pcs: z.record(z.string(), DeclaredPcSchema),
});
export type RoomRoster = z.infer<typeof RoomRosterSchema>;

/** 缺失或损坏时以空名册兜底（声明属准备态，坏文件不应挡住开团） */
export async function readRoomRoster(layout: DataLayout, roomId: string): Promise<RoomRoster> {
  const raw = await new ArchiveJsonStore(layout.rosterFile(roomId), 'roster')
    .read()
    .catch(() => null);
  return parseRoster(raw);
}

function parseRoster(current: unknown): RoomRoster {
  const parsed = RoomRosterSchema.safeParse(current);
  return parsed.success ? parsed.data : { pcs: {} };
}

/** 声明/覆盖（PUT 幂等）：整表读改写关进文件锁（2026-09-25 members 锁同款） */
export async function declarePc(
  layout: DataLayout,
  roomId: string,
  memberId: string,
  declared: DeclaredPc,
): Promise<RoomRoster> {
  return new ArchiveJsonStore(layout.rosterFile(roomId), 'roster').update((current) => {
    const roster = parseRoster(current);
    roster.pcs[memberId] = declared;
    return RoomRosterSchema.parse(roster);
  });
}

export async function undeclarePc(
  layout: DataLayout,
  roomId: string,
  memberId: string,
): Promise<boolean> {
  let removed = false;
  await new ArchiveJsonStore(layout.rosterFile(roomId), 'roster').update((current) => {
    const roster = parseRoster(current);
    if (roster.pcs[memberId] === undefined) return roster;
    delete roster.pcs[memberId];
    removed = true;
    return roster;
  });
  return removed;
}
