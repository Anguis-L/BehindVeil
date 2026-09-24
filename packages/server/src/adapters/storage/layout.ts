import { join } from 'node:path';

/**
 * data/ 目录布局（T-M0-03，TDD §6）。全部路径推导集中此处，禁止散落的字符串拼接。
 *
 * data/
 * ├── config.yaml
 * ├── rooms/<roomId>/{room.json, members.json, sessions/<sessionId>/{session.json, messages.jsonl, state.json}}
 * ├── cards/                      # 角色卡库（M5）
 * ├── modules/<moduleId>/          # 模组包（M5）
 * └── logs/audit-dice.jsonl       # 全局骰子审计流水（M4）
 */
export interface DataLayout {
  readonly root: string;
  readonly configFile: string;
  readonly roomsDir: string;
  readonly cardsDir: string;
  readonly modulesDir: string;
  readonly logsDir: string;
  readonly auditDiceFile: string;
  roomDir(roomId: string): string;
  roomFile(roomId: string): string;
  membersFile(roomId: string): string;
  sessionsDir(roomId: string): string;
  sessionDir(roomId: string, sessionId: string): string;
  sessionFile(roomId: string, sessionId: string): string;
  messagesFile(roomId: string, sessionId: string): string;
  stateFile(roomId: string, sessionId: string): string;
}

export function createDataLayout(root: string): DataLayout {
  const roomsDir = join(root, 'rooms');
  return {
    root,
    configFile: join(root, 'config.yaml'),
    roomsDir,
    cardsDir: join(root, 'cards'),
    modulesDir: join(root, 'modules'),
    logsDir: join(root, 'logs'),
    auditDiceFile: join(root, 'logs', 'audit-dice.jsonl'),
    roomDir: (roomId) => join(roomsDir, roomId),
    roomFile: (roomId) => join(roomsDir, roomId, 'room.json'),
    membersFile: (roomId) => join(roomsDir, roomId, 'members.json'),
    sessionsDir: (roomId) => join(roomsDir, roomId, 'sessions'),
    sessionDir: (roomId, sessionId) => join(roomsDir, roomId, 'sessions', sessionId),
    sessionFile: (roomId, sessionId) =>
      join(roomsDir, roomId, 'sessions', sessionId, 'session.json'),
    messagesFile: (roomId, sessionId) =>
      join(roomsDir, roomId, 'sessions', sessionId, 'messages.jsonl'),
    stateFile: (roomId, sessionId) => join(roomsDir, roomId, 'sessions', sessionId, 'state.json'),
  };
}
