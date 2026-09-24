import { readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import {
  MessageSchema,
  RoomSchema,
  SessionSchema,
  type Room,
  type Session,
} from '@behindveil/shared';
import type { ZodType } from 'zod';
import { JsonlStore } from './jsonl-store.js';
import { JsonStore } from './json-store.js';
import { createDataLayout } from './layout.js';

/**
 * 启动恢复器（T-M0-04，TDD §6 / NFR-06 / SDD §5.3）。
 *
 * 扫描 data/rooms/：重建房间与会话元数据、统计消息数与最新 seq；
 * messages.jsonl 逐行过 MessageSchema——非法 JSON 与 Schema 不符的行均按坏行处理
 * （跳过 + 计数 + 告警，TC-NFR-06-002），后续正常行继续可用。
 * room.json 缺失/无效的房间整间跳过（含其会话）并告警，不崩溃。
 */
export interface RecoveredSession {
  /**
   * session.json 校验通过时为完整元数据；缺失/损坏时以目录名重建最小骨架
   * （sessionId 取目录名、roomId 取房间目录名），并产出告警。
   */
  session: Session | { id: string; roomId: string };
  messageCount: number;
  /** 恢复出的最大 seq；无消息时为 null */
  lastSeq: number | null;
}

export interface RecoveryReport {
  rooms: Room[];
  sessions: RecoveredSession[];
  /** 被跳过的坏行总数（非法 JSON + Schema 不符） */
  badLines: number;
  /** 人类可读告警，由组装根写入日志 */
  warnings: string[];
}

export async function recover(dataDir: string): Promise<RecoveryReport> {
  const layout = createDataLayout(dataDir);
  const warnings: string[] = [];
  const rooms: Room[] = [];
  const sessions: RecoveredSession[] = [];
  let badLines = 0;

  let roomEntries: Dirent[];
  try {
    roomEntries = await readdir(layout.roomsDir, { withFileTypes: true });
  } catch {
    // data/rooms 不存在 = 首次启动，空恢复
    return { rooms, sessions, badLines, warnings };
  }

  for (const entry of roomEntries) {
    if (!entry.isDirectory()) continue;
    const roomId = entry.name;

    const room = await readValidated(layout.roomFile(roomId), RoomSchema);
    if (!room.ok) {
      warnings.push(`rooms/${roomId}/room.json ${room.reason}，整间跳过`);
      continue;
    }
    rooms.push(room.value);

    let sessionEntries: Dirent[];
    try {
      sessionEntries = await readdir(layout.sessionsDir(roomId), { withFileTypes: true });
    } catch {
      continue; // 尚无 sessions 目录
    }

    for (const sessionEntry of sessionEntries) {
      if (!sessionEntry.isDirectory()) continue;
      const sessionId = sessionEntry.name;
      const relative = `rooms/${roomId}/sessions/${sessionId}`;

      const session = await readValidated(layout.sessionFile(roomId, sessionId), SessionSchema);
      const meta: RecoveredSession['session'] = session.ok
        ? session.value
        : { id: sessionId, roomId };
      if (!session.ok) {
        warnings.push(`${relative}/session.json ${session.reason}，已按目录名重建最小元数据`);
      }

      const { records, badLines: fileBadLines } = await new JsonlStore(
        layout.messagesFile(roomId, sessionId),
      ).readAll();
      badLines += fileBadLines;
      if (fileBadLines > 0) {
        warnings.push(`${relative}/messages.jsonl 跳过 ${fileBadLines} 条非法 JSON 行`);
      }

      let messageCount = 0;
      let lastSeq: number | null = null;
      for (const record of records) {
        const parsed = MessageSchema.safeParse(record);
        if (!parsed.success) {
          badLines += 1;
          warnings.push(`${relative}/messages.jsonl 有一条消息未通过 Schema 校验，已跳过`);
          continue;
        }
        messageCount += 1;
        if (lastSeq === null || parsed.data.seq > lastSeq) lastSeq = parsed.data.seq;
      }

      sessions.push({ session: meta, messageCount, lastSeq });
    }
  }

  return { rooms, sessions, badLines, warnings };
}

type Validated<T> = { ok: true; value: T } | { ok: false; reason: string };

async function readValidated<T>(file: string, schema: ZodType<T>): Promise<Validated<T>> {
  let json: unknown;
  try {
    json = await new JsonStore(file).read();
  } catch (err) {
    return { ok: false, reason: `无法解析（${err instanceof Error ? err.message : String(err)}）` };
  }
  if (json === null) return { ok: false, reason: '缺失' };
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue ? issue.path.join('.') : '(根)';
    return { ok: false, reason: `校验失败（${where}）` };
  }
  return { ok: true, value: parsed.data };
}
