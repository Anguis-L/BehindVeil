import { readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import type { ArchiveKind } from '@behindveil/shared';
import { createDataLayout, type DataLayout } from './layout.js';

/**
 * 存档枚举器（T-M10-01）：按 data/ 布局列出全部「服务端写入的 JSON 存档」。
 *
 * 门禁（version-gate）、aidle-migrate、自检共用同一清单，避免各自拼路径漏文件。
 * 覆盖五类：room / members / roster / session / state；worldbook.json 属用户资产
 * （D-08 手编工作流，无服务端写路径），待 M11 编辑器落地后收编。
 * 文件不存在不列出（首次启动 / 未进房 / 未声明都是合法空缺）。
 */
export interface ArchiveFile {
  readonly absolutePath: string;
  /** 相对 data/ 的路径，报告与错误信息用 */
  readonly relativePath: string;
  readonly kind: ArchiveKind;
}

const ROOM_LEVEL: ReadonlyArray<{
  file: 'room.json' | 'members.json' | 'roster.json';
  kind: ArchiveKind;
}> = [
  { file: 'room.json', kind: 'room' },
  { file: 'members.json', kind: 'members' },
  { file: 'roster.json', kind: 'roster' },
];

const SESSION_LEVEL: ReadonlyArray<{ file: 'session.json' | 'state.json'; kind: ArchiveKind }> = [
  { file: 'session.json', kind: 'session' },
  { file: 'state.json', kind: 'state' },
];

export async function listArchiveFiles(
  dataDir: string,
  layout?: DataLayout,
): Promise<ArchiveFile[]> {
  const l = layout ?? createDataLayout(dataDir);
  const result: ArchiveFile[] = [];

  let roomEntries: Dirent[];
  try {
    roomEntries = await readdir(l.roomsDir, { withFileTypes: true });
  } catch {
    return result; // data/rooms 不存在 = 首次启动，零存档
  }

  for (const entry of roomEntries) {
    if (!entry.isDirectory()) continue;
    const roomId = entry.name;
    for (const { file, kind } of ROOM_LEVEL) {
      result.push({
        absolutePath: join(l.roomsDir, roomId, file),
        relativePath: `rooms/${roomId}/${file}`,
        kind,
      });
    }
    let sessionEntries: Dirent[];
    try {
      sessionEntries = await readdir(l.sessionsDir(roomId), { withFileTypes: true });
    } catch {
      continue; // 尚无 sessions 目录
    }
    for (const sessionEntry of sessionEntries) {
      if (!sessionEntry.isDirectory()) continue;
      const sessionId = sessionEntry.name;
      for (const { file, kind } of SESSION_LEVEL) {
        result.push({
          absolutePath: join(l.roomsDir, roomId, 'sessions', sessionId, file),
          relativePath: `rooms/${roomId}/sessions/${sessionId}/${file}`,
          kind,
        });
      }
    }
  }
  return result;
}
