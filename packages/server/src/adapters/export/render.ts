import type { Member, Message, RollCheck, Session, StateBoard } from '@behindveil/shared';

/**
 * 导出渲染模型（T-M6-01，FR-12；对应 SDD §3.2 M8 行）。
 *
 * 职责边界：只把「消息流 + 展示所需元数据」映射成与输出格式无关的中间模型，
 * Markdown 与染色 HTML 各自消费它，避免两套渲染逻辑各自理解一遍消息类型。
 *
 * 安全不变式（TDD §8）：本模块**不接收世界书与 prompt trace**——
 * kpOnly 条目（模组真相）只进 AI 上下文，不得出现在任何导出产物里。
 * 输入类型不含二者，是结构上的保证而非约定（回归护栏见 html.test.ts）。
 *
 * 完整性口径：导出为 **Host 视角完整版**，暗骰与仅 Host 可见的场外消息照实导出
 * 并打标记（审计流水本就完整记录，隐藏的是广播范围，不是凭据）。
 */

/** 判定语义色档位；取值对齐 packages/web/src/styles/tokens.css 的 --bv-judge-* */
export type JudgeLevel = 'critical' | 'extreme' | 'hard' | 'regular' | 'fail' | 'fumble' | 'none';

/** 骰子条目：审计五要素齐全（expr / rolls / total / 判定 / 流水号） */
export interface DiceExport {
  expr: string;
  /** 原始骰值，按骰组呈现：`[45]`、`[3, 6] [2]` */
  rolls: string;
  /** 应用 kh/kl/dh/dl 后的保留值 */
  kept: string;
  total: number;
  /** 判定中文（无判定为 `—`） */
  outcome: string;
  level: JudgeLevel;
  /** 审计流水号（data/logs/audit-dice.jsonl） */
  auditSeq: string;
  rollId: string;
  hidden: boolean;
}

export interface SnapshotPcExport {
  memberId: string;
  /** memberId 对应的显示名（缺失时回退为 id 本身） */
  memberName: string;
  playerName: string;
  /** COC 为当前值；5e 为 { max, current }（T-M8-00 消费清单 #4） */
  hp: number | { max: number; current: number };
  /** 5e 无理智/魔力/幸运 → null */
  san: number | null;
  mp: number | null;
  luck: number | null;
  conditions: string[];
}

/** 快照 HP 展示：COC 当前值；5e `current/max` */
export function hpTextOf(pc: SnapshotPcExport): string {
  return typeof pc.hp === 'number' ? String(pc.hp) : `${pc.hp.current}/${pc.hp.max}`;
}

/** 5e 缺失项展示为 `—` */
export function statTextOf(value: number | null): string {
  return value === null ? '—' : String(value);
}

export interface SnapshotExport {
  sceneName: string;
  sceneTime: string;
  sceneDesc: string;
  pcs: SnapshotPcExport[];
  facts: string[];
}

export interface ExportEntry {
  seq: number;
  /** 展示用时间（`YYYY-MM-DD HH:MM:SS`；非 ISO 串原样保留） */
  time: string;
  /** 六类消息之一，决定配色与标签 */
  category: Message['type'];
  categoryLabel: string;
  speaker: string;
  /** 附加标记：暗骰 / 仅 Host 可见 / 密语→某某 */
  tag: string | null;
  /** 文本类消息正文；骰子与快照条目为空串 */
  body: string;
  dice: DiceExport | null;
  snapshot: SnapshotExport | null;
}

export interface ExportInput {
  roomName: string;
  session: Session;
  /** 用于 senderId → 显示名；缺失的 id 回退为 id 本身 */
  members: Member[];
  messages: Message[];
}

const CATEGORY_LABELS: Record<Message['type'], string> = {
  ic: '扮演',
  ooc: '场外',
  system: '系统',
  dice: '骰子',
  narration: '叙事',
  state_snapshot: '状态快照',
};

const SYSTEM_SUBTYPE_LABELS: Record<string, string> = {
  ai_directive_result: '检定结果',
  join: '加入',
  leave: '离开',
  notice: '通知',
};

/** KP 叙事与引擎代掷的骰子没有 senderId，统一署名「KP」 */
const KP_SPEAKER = 'KP';

function formatTime(ts: string): string {
  return ts.length >= 19 ? `${ts.slice(0, 10)} ${ts.slice(11, 19)}` : ts;
}

export function judgeLevelOf(check: RollCheck | undefined): JudgeLevel {
  if (!check) return 'none';
  if (check.outcome === 'critical') return 'critical';
  if (check.outcome === 'fumble') return 'fumble';
  if (check.outcome === 'fail') return 'fail';
  if (check.grade === 'extreme') return 'extreme';
  if (check.grade === 'hard') return 'hard';
  return 'regular';
}

export function outcomeTextOf(check: RollCheck | undefined): string {
  if (!check) return '—';
  if (check.outcome === 'critical') return '大成功';
  if (check.outcome === 'fumble') return '大失败';
  if (check.outcome === 'fail') return '失败';
  if (check.grade === 'extreme') return '极难成功';
  if (check.grade === 'hard') return '困难成功';
  return '普通成功';
}

function groupText(groups: number[][]): string {
  return groups.map((group) => `[${group.join(', ')}]`).join(' ');
}

function toDiceExport(message: Extract<Message, { type: 'dice' }>): DiceExport {
  const { roll } = message;
  return {
    expr: roll.expr,
    rolls: groupText(roll.rolls),
    kept: `[${roll.kept.join(', ')}]`,
    total: roll.total,
    outcome: outcomeTextOf(roll.check),
    level: judgeLevelOf(roll.check),
    auditSeq: roll.audit.seq,
    rollId: roll.audit.rollId,
    hidden: message.hidden,
  };
}

function toSnapshotExport(board: StateBoard, nameOf: (id: string) => string): SnapshotExport {
  const pcs: SnapshotPcExport[] = Object.entries(board.pcs).map(([memberId, pc]) => {
    const { sheet } = pc;
    return {
      memberId,
      memberName: nameOf(memberId),
      playerName: sheet.playerName,
      ...(sheet.rulebook === 'dnd5e'
        ? { hp: { ...sheet.hp }, san: null, mp: null, luck: null }
        : { hp: sheet.hp, san: sheet.san, mp: sheet.mp, luck: sheet.luck }),
      conditions: [...pc.conditions],
    };
  });
  return {
    sceneName: board.scene.name,
    sceneTime: board.scene.time,
    sceneDesc: board.scene.publicDesc,
    pcs,
    facts: [...board.facts],
  };
}

/**
 * 消息流 → 导出条目。输出按 seq 升序（调用方通常已排序，此处再排一次兜底，
 * 防止落盘顺序与 seq 顺序在极端恢复场景下不一致）。
 */
export function toExportEntries(input: ExportInput): ExportEntry[] {
  const nameById = new Map(input.members.map((m) => [m.id, m.name]));
  const nameOf = (id: string): string => nameById.get(id) ?? id;

  const ordered = [...input.messages].sort((a, b) => a.seq - b.seq);

  return ordered.map((message): ExportEntry => {
    const base = { seq: message.seq, time: formatTime(message.ts) };

    switch (message.type) {
      case 'ic':
        return {
          ...base,
          category: 'ic',
          categoryLabel: CATEGORY_LABELS.ic,
          speaker: nameOf(message.senderId),
          tag: null,
          body: message.content,
          dice: null,
          snapshot: null,
        };

      case 'ooc': {
        let tag: string | null = null;
        if (message.visibility === 'whisper') {
          tag = `密语→${message.targetId ? nameOf(message.targetId) : '?'}`;
        } else if (message.visibility === 'host') {
          tag = '仅 Host 可见';
        }
        return {
          ...base,
          category: 'ooc',
          categoryLabel: CATEGORY_LABELS.ooc,
          speaker: nameOf(message.senderId),
          tag,
          body: message.content,
          dice: null,
          snapshot: null,
        };
      }

      case 'system':
        return {
          ...base,
          category: 'system',
          categoryLabel: CATEGORY_LABELS.system,
          speaker: SYSTEM_SUBTYPE_LABELS[message.subtype] ?? message.subtype,
          tag: null,
          body: message.content,
          dice: null,
          snapshot: null,
        };

      case 'dice':
        return {
          ...base,
          category: 'dice',
          categoryLabel: CATEGORY_LABELS.dice,
          speaker: message.senderId ? nameOf(message.senderId) : KP_SPEAKER,
          tag: message.hidden ? '暗骰' : null,
          body: '',
          dice: toDiceExport(message),
          snapshot: null,
        };

      case 'narration':
        return {
          ...base,
          category: 'narration',
          categoryLabel: CATEGORY_LABELS.narration,
          speaker: KP_SPEAKER,
          tag: null,
          body: message.content,
          dice: null,
          snapshot: null,
        };

      case 'state_snapshot':
        return {
          ...base,
          category: 'state_snapshot',
          categoryLabel: CATEGORY_LABELS.state_snapshot,
          speaker: '状态板',
          tag: null,
          body: '',
          dice: null,
          snapshot: toSnapshotExport(message.stateBoard, nameOf),
        };
    }
  });
}
