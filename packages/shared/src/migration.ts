import { z } from 'zod';

/**
 * 存档版本化与迁移契约（v3 FR-30 / ADR-3-05，设计文档 §5.2）。
 *
 * 全部服务端写入的 JSON 存档带根字段 `schemaVersion`（设计原文「首字段」）：
 * - v2.0 封版存档定 `SCHEMA_VERSION = 1`（补写即迁移链 v0→v1 节点）；
 * - v3 起结构性变更从 2 起编号，**凡结构变更必须同卡交付迁移函数**（章程化）；
 * - 消息 JSONL（messages/audit-dice/ai-directive）追加型不迁移；
 * - 用户资产（cards/、modules/）不在此管辖：内容归导入者所有，完整性由装载时 zod 校验兜底；
 * - 房间级 worldbook.json 于 M11（T-M11-06 编辑器）起收编：服务端第一次握有写路径，
 *   落盘即带信封；手编的裸 `{entries}` 仍按版本 0 读取（不强制先跑迁移）。
 *
 * 迁移函数是纯函数：`chain[v]` 把版本 v 的文档升到 v+1，输入输出都是「落盘文档」本身。
 * members.json 的 v0 根是数组（无法内联字段），v1 起重构为 `{ schemaVersion, members: [...] }`。
 */

/**
 * 当前存档版本。v2.0 封版存档 = 1；首个 v3 结构变更（M12 conditions 对象化）= 2。
 * 版本是全仓统一的「档号」：非 state 存档在 v2 结构未变，链里仍需一节恒等推进，
 * 否则它们会停在 1 而被启动版本门禁当成「未迁移的存量存档」拒开。
 */
export const SCHEMA_VERSION = 2;

export const ARCHIVE_KINDS = [
  'room',
  'members',
  'worldbook',
  'roster',
  'session',
  'state',
] as const;
export type ArchiveKind = (typeof ARCHIVE_KINDS)[number];

/**
 * 版本未写入字段的存档视作版本 0（v2.0 及更早）。
 * 数组根 / 无 schemaVersion 的对象根都归 0；其余形态（原始值、null）属损坏输入，由调用方拒绝。
 */
export const VERSIONLESS = 0;

export type MigrationFn = (doc: unknown) => unknown;

export interface Migrator {
  currentVersion: number;
  /** chain[fromVersion] → 产出版本 fromVersion+1 的文档；0 = 版本不详（v2.0 存量补写） */
  chain: Record<number, MigrationFn>;
}

/**
 * 在文档根补写版本字段（放首位，便于人读）。
 * 必须先摘掉 payload 里的旧版本字段——否则展开会把它覆盖回来，
 * 恒等推进节点（v1→v2 结构未变）会写出「版本没涨」的假象。
 */
function stamp(payload: Record<string, unknown>, version: number): Record<string, unknown> {
  const { schemaVersion: _legacy, ...rest } = payload;
  void _legacy;
  return { schemaVersion: version, ...rest };
}

/** 恒等推进：结构未变，只把档号带到下一版 */
function advance(kind: ArchiveKind): MigrationFn {
  return (doc) => stamp(asObject(doc, kind), 2);
}

/**
 * state v1→v2（FR-39）：`pcs[*].conditions` 由 `string[]` 升为 `{ label }[]`。
 * 幂等——已是对象形态的条目原样保留，重复迁移不产生嵌套。
 */
function stateConditionsToObjects(doc: unknown): unknown {
  const root = asObject(doc, 'state');
  const pcs = root['pcs'];
  if (pcs === undefined) return stamp(root, 2);
  if (pcs === null || typeof pcs !== 'object' || Array.isArray(pcs)) {
    throw new Error('state 存档的 pcs 不是对象，无法升级 conditions');
  }
  const nextPcs: Record<string, unknown> = {};
  for (const [memberId, pc] of Object.entries(pcs as Record<string, unknown>)) {
    if (pc === null || typeof pc !== 'object' || Array.isArray(pc)) {
      throw new Error(`state 存档的 pcs.${memberId} 不是对象，无法升级 conditions`);
    }
    const record = pc as Record<string, unknown>;
    const conditions = record['conditions'];
    nextPcs[memberId] =
      conditions === undefined
        ? record
        : { ...record, conditions: conditionsToObjects(conditions, memberId) };
  }
  return stamp({ ...root, pcs: nextPcs }, 2);
}

function conditionsToObjects(value: unknown, memberId: string): unknown {
  if (!Array.isArray(value)) {
    throw new Error(`state 存档的 pcs.${memberId}.conditions 不是数组，无法升级`);
  }
  return value.map((entry) => (typeof entry === 'string' ? { label: entry } : entry));
}

/**
 * 全量注册表：每类存档一条链。v0→v1 是 v2.0 存量补写；v1→v2 中只有 state 有结构变更，
 * 其余为恒等推进（保持全仓档号一致）。
 */
export const MIGRATORS: Record<ArchiveKind, Migrator> = {
  room: {
    currentVersion: SCHEMA_VERSION,
    chain: { 0: (doc) => stamp(asObject(doc, 'room'), 1), 1: advance('room') },
  },
  members: {
    currentVersion: SCHEMA_VERSION,
    chain: {
      // v0 数组根 → v1 对象根（数组无法内联版本字段，设计 §5.2 落地注记）
      0: (doc) => stamp({ members: doc }, 1),
      1: (doc) => stamp(asObject(doc, 'members'), 2),
    },
  },
  worldbook: {
    // T-M11-06 编辑器落地后启用（写入口见 server domain/worldbook/store.ts）
    currentVersion: SCHEMA_VERSION,
    chain: { 0: (doc) => stamp(asObject(doc, 'worldbook'), 1), 1: advance('worldbook') },
  },
  roster: {
    currentVersion: SCHEMA_VERSION,
    chain: { 0: (doc) => stamp(asObject(doc, 'roster'), 1), 1: advance('roster') },
  },
  session: {
    currentVersion: SCHEMA_VERSION,
    chain: { 0: (doc) => stamp(asObject(doc, 'session'), 1), 1: advance('session') },
  },
  state: {
    currentVersion: SCHEMA_VERSION,
    chain: { 0: (doc) => stamp(asObject(doc, 'state'), 1), 1: stateConditionsToObjects },
  },
};

function asObject(doc: unknown, kind: string): Record<string, unknown> {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`${kind} 存档根不是对象，无法补写版本字段`);
  }
  return doc as Record<string, unknown>;
}

/**
 * 读取落盘文档的 schemaVersion；无字段 / 数组根 = VERSIONLESS(0)。
 * 非整数版本或原始值根抛错（损坏输入，宁可拒绝）。
 */
export function readSchemaVersion(doc: unknown): number {
  if (Array.isArray(doc)) return VERSIONLESS;
  if (doc === null || typeof doc !== 'object') {
    throw new Error('存档根不是 JSON 对象/数组，无法判定版本');
  }
  const raw = (doc as Record<string, unknown>)['schemaVersion'];
  if (raw === undefined) return VERSIONLESS;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    throw new Error(`schemaVersion 非法：${String(raw)}`);
  }
  return raw;
}

/**
 * 把一份存档文档沿注册表链升到当前版本（纯函数，不改输入）。
 * 版本超前（存档来自更新版本的服务端）或链缺失时抛错——宁可拒绝，不静默猜。
 */
export function migrateArchive(kind: ArchiveKind, doc: unknown): unknown {
  const migrator = MIGRATORS[kind];
  let version = readSchemaVersion(doc);
  if (version > migrator.currentVersion) {
    throw new Error(
      `${kind} 存档版本 ${version} 超前于当前支持的 ${migrator.currentVersion}（存档来自更新版本的服务端？）`,
    );
  }
  let current = doc;
  while (version < migrator.currentVersion) {
    const step = migrator.chain[version];
    if (!step) {
      throw new Error(`${kind} 迁移链缺少 ${version}→${version + 1} 节点`);
    }
    current = step(current);
    const next = readSchemaVersion(current);
    if (next !== version + 1) {
      throw new Error(`${kind} 迁移链 ${version}→${version + 1} 节点产出版本 ${next}，违反链契约`);
    }
    version = next;
  }
  return current;
}

/** 落盘存档信封校验（gate/自检用）：对象根 + 整数版本字段 */
export const VersionedDocSchema = z.object({
  schemaVersion: z.number().int().nonnegative(),
});
