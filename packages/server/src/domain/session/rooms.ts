import { RoomSchema, type Room, type SessionSettings } from '@behindveil/shared';
import { z } from 'zod';
import { JsonStore } from '../../adapters/storage/json-store.js';
import type { DataLayout } from '../../adapters/storage/layout.js';
import { readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { generateHostToken, generateInviteCode, generateRoomId } from './ids.js';

/**
 * Room 仓库（T-M1-01，TDD §3.1/§6）：room.json 落盘 + 邀请码/配置管理。
 * room.json 在 Room 之外多存一个 hostToken（开放问题①默认方案）——
 * 它是服务端机密，任何 HTTP 响应 / Socket 广播都必须经 toPublicRoom 剥离。
 */

const RoomFileSchema = RoomSchema.extend({ hostToken: z.string() });
export type RoomFile = z.infer<typeof RoomFileSchema>;

export function toPublicRoom(file: RoomFile): Room {
  const { hostToken: _hostToken, ...room } = file;
  return room;
}

export interface CreateRoomInput {
  name: string;
  memberLimit?: number;
  defaultSessionSettings?: SessionSettings;
}

export async function createRoom(layout: DataLayout, input: CreateRoomInput): Promise<RoomFile> {
  const room: RoomFile = {
    id: generateRoomId(),
    name: input.name,
    createdAt: new Date().toISOString(),
    inviteCode: generateInviteCode(),
    activeSessionId: null,
    memberLimit: input.memberLimit ?? 8,
    ...(input.defaultSessionSettings
      ? { defaultSessionSettings: input.defaultSessionSettings }
      : {}),
    hostToken: generateHostToken(),
  };
  await saveRoomFile(layout, room);
  return room;
}

export async function saveRoomFile(layout: DataLayout, room: RoomFile): Promise<void> {
  await new JsonStore(layout.roomFile(room.id)).write(room);
}

/** 缺失或校验失败一律返回 null（损坏文件的告警由启动恢复负责） */
export async function readRoomFile(layout: DataLayout, roomId: string): Promise<RoomFile | null> {
  const json = await new JsonStore(layout.roomFile(roomId)).read();
  if (json === null) return null;
  const parsed = RoomFileSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

export async function listRoomFiles(layout: DataLayout): Promise<RoomFile[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(layout.roomsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const rooms: RoomFile[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const room = await readRoomFile(layout, entry.name);
    if (room) rooms.push(room);
  }
  return rooms;
}

export async function findByInviteCode(
  layout: DataLayout,
  inviteCode: string,
): Promise<RoomFile | null> {
  const rooms = await listRoomFiles(layout);
  return rooms.find((room) => room.inviteCode === inviteCode) ?? null;
}

export async function resetInviteCode(layout: DataLayout, roomId: string): Promise<string | null> {
  const room = await readRoomFile(layout, roomId);
  if (!room) return null;
  room.inviteCode = generateInviteCode();
  await saveRoomFile(layout, room);
  return room.inviteCode;
}

export interface RoomSettingsPatch {
  name?: string;
  memberLimit?: number;
  defaultSessionSettings?: SessionSettings;
}

export async function updateRoomSettings(
  layout: DataLayout,
  roomId: string,
  patch: RoomSettingsPatch,
): Promise<RoomFile | null> {
  const room = await readRoomFile(layout, roomId);
  if (!room) return null;
  if (patch.name !== undefined) room.name = patch.name;
  if (patch.memberLimit !== undefined) room.memberLimit = patch.memberLimit;
  if (patch.defaultSessionSettings !== undefined) {
    room.defaultSessionSettings = patch.defaultSessionSettings;
  }
  await saveRoomFile(layout, room);
  return room;
}
