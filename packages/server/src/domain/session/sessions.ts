import {
  SessionSchema,
  StateBoardSchema,
  type Session,
  type SessionSettings,
} from '@behindveil/shared';
import { readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { JsonStore } from '../../adapters/storage/json-store.js';
import type { DataLayout } from '../../adapters/storage/layout.js';
import { readRoomFile, saveRoomFile } from './rooms.js';
import { generateSessionId } from './ids.js';

/**
 * Session 仓库（T-M1-01/07，TDD §3.1/§6）：session.json + state.json 初始化。
 * 一房多会话（FR-11）：开新会话自动结束当前活跃会话；activeSessionId 指向唯一活跃会话。
 */

export interface CreateSessionInput {
  moduleId: string;
  settings: SessionSettings;
}

async function saveSession(layout: DataLayout, roomId: string, session: Session): Promise<void> {
  await new JsonStore(layout.sessionFile(roomId, session.id)).write(session);
}

/**
 * 开新会话：自动结束当前活跃会话（endedAt 落今），写 session.json + 初始 state.json，
 * 并把 room.activeSessionId 指向新会话。
 */
export async function createSession(
  layout: DataLayout,
  roomId: string,
  input: CreateSessionInput,
): Promise<Session> {
  const room = await readRoomFile(layout, roomId);
  if (!room) throw new Error(`房间不存在：${roomId}`);

  const now = new Date().toISOString();
  if (room.activeSessionId) {
    const previous = await readSession(layout, roomId, room.activeSessionId);
    if (previous && previous.endedAt === null) {
      previous.endedAt = now;
      await saveSession(layout, roomId, previous);
    }
  }

  const session: Session = SessionSchema.parse({
    id: generateSessionId(),
    roomId,
    moduleRef: input.moduleId,
    startedAt: now,
    endedAt: null,
    stateBoardVersion: 0,
    settings: input.settings,
  });
  await saveSession(layout, roomId, session);

  const stateBoard = StateBoardSchema.parse({
    version: 0,
    pcs: {},
    scene: { name: '', time: '', publicDesc: '' },
    facts: [],
    updatedAt: now,
  });
  await new JsonStore(layout.stateFile(roomId, session.id)).write(stateBoard);

  room.activeSessionId = session.id;
  await saveRoomFile(layout, room);
  return session;
}

export async function readSession(
  layout: DataLayout,
  roomId: string,
  sessionId: string,
): Promise<Session | null> {
  const json = await new JsonStore(layout.sessionFile(roomId, sessionId)).read();
  if (json === null) return null;
  const parsed = SessionSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

export async function listSessions(layout: DataLayout, roomId: string): Promise<Session[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(layout.sessionsDir(roomId), { withFileTypes: true });
  } catch {
    return [];
  }
  const sessions: Session[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const session = await readSession(layout, roomId, entry.name);
    if (session) sessions.push(session);
  }
  return sessions.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/** 结束会话（T-M1-07）：endedAt 落今；若它是活跃会话则同时清空 activeSessionId */
export async function endSession(
  layout: DataLayout,
  roomId: string,
  sessionId: string,
): Promise<Session | null> {
  const session = await readSession(layout, roomId, sessionId);
  if (!session) return null;
  if (session.endedAt === null) {
    session.endedAt = new Date().toISOString();
    await saveSession(layout, roomId, session);
  }
  const room = await readRoomFile(layout, roomId);
  if (room && room.activeSessionId === sessionId) {
    room.activeSessionId = null;
    await saveRoomFile(layout, room);
  }
  return session;
}

/** 切换活跃会话（T-M1-07）：仅允许指向本房已存在的会话（如复播旧团） */
export async function setActiveSession(
  layout: DataLayout,
  roomId: string,
  sessionId: string,
): Promise<Session | null> {
  const session = await readSession(layout, roomId, sessionId);
  if (!session) return null;
  const room = await readRoomFile(layout, roomId);
  if (!room) return null;
  room.activeSessionId = sessionId;
  await saveRoomFile(layout, room);
  return session;
}
