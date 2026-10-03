import { join } from 'node:path';

/**
 * data/ 目录布局（T-M0-03，TDD §6）。全部路径推导集中此处，禁止散落的字符串拼接。
 *
 * data/
 * ├── config.yaml
 * ├── rooms/<roomId>/{room.json, members.json, worldbook.json, roster.json, sessions/<sessionId>/{session.json, messages.jsonl, state.json}}
 * ├── cards/                      # 角色卡库（M5）
 * ├── modules/<moduleId>/          # 模组包（M5）
 * ├── index/                      # 服务端运行时元数据（v3）：backup-cursor.json 热备游标；
 * │                               # M11 跨房间索引 global.jsonl 亦落此处
 * └── logs/
 *     ├── audit-dice.jsonl        # 全局骰子审计流水（M4）
 *     └── ai-directive.jsonl      # AI 指令失败块留档（T-M3-07，测试文档 §12.4）
 */
export interface DataLayout {
  readonly root: string;
  readonly configFile: string;
  readonly roomsDir: string;
  readonly cardsDir: string;
  readonly modulesDir: string;
  readonly logsDir: string;
  /** 服务端运行时元数据目录（v3；热备游标、M11 全局索引） */
  readonly indexDir: string;
  /** 热备游标（T-M10-02，FR-31）：{offset, mtimeMs, size} per file，原子写 */
  readonly backupCursorFile: string;
  readonly auditDiceFile: string;
  /** AI 指令失败块留档（T-M3-07：解析失败/白名单拒绝的原始文本，供回归分析） */
  readonly directiveLogFile: string;
  roomDir(roomId: string): string;
  roomFile(roomId: string): string;
  membersFile(roomId: string): string;
  /** 房间级手编世界书（T-M2-06，决议 D-08：JSON 手编 + 载入校验，无编辑 UI） */
  worldbookFile(roomId: string): string;
  /** 房间级 PC 声明（T-M5-04，SDD §5.1：开团前声明，开团时装配进状态板初始） */
  rosterFile(roomId: string): string;
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
    indexDir: join(root, 'index'),
    backupCursorFile: join(root, 'index', 'backup-cursor.json'),
    auditDiceFile: join(root, 'logs', 'audit-dice.jsonl'),
    directiveLogFile: join(root, 'logs', 'ai-directive.jsonl'),
    roomDir: (roomId) => join(roomsDir, roomId),
    roomFile: (roomId) => join(roomsDir, roomId, 'room.json'),
    membersFile: (roomId) => join(roomsDir, roomId, 'members.json'),
    worldbookFile: (roomId) => join(roomsDir, roomId, 'worldbook.json'),
    rosterFile: (roomId) => join(roomsDir, roomId, 'roster.json'),
    sessionsDir: (roomId) => join(roomsDir, roomId, 'sessions'),
    sessionDir: (roomId, sessionId) => join(roomsDir, roomId, 'sessions', sessionId),
    sessionFile: (roomId, sessionId) =>
      join(roomsDir, roomId, 'sessions', sessionId, 'session.json'),
    messagesFile: (roomId, sessionId) =>
      join(roomsDir, roomId, 'sessions', sessionId, 'messages.jsonl'),
    stateFile: (roomId, sessionId) => join(roomsDir, roomId, 'sessions', sessionId, 'state.json'),
  };
}
