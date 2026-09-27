import type { PipelineTracePayload, Session, SessionSettings } from '@behindveil/shared';

/**
 * KP 控制台纯逻辑（T-M6-04/05，FR-13 / R-02）。
 *
 * 抽成 .ts 是为了可测：trace 结构整理、数值/成本格式化、参数校验都不碰 DOM，
 * 组件只负责渲染。数值口径一律来自服务端（指标与 trace 都是服务端下发的）。
 */

// ---- 阶段名 → 界面文案（管线阶段名是契约，界面另给中文短名）----

const STAGE_LABELS: Record<string, string> = {
  'S1-skeleton': '骨架（人格 + 规则速查）',
  'S2-state': '状态板注入',
  'S3-worldbook-scan': '世界书扫描',
  'S4-budget-cut': '预算裁剪',
  'S5-history-trim': '历史裁剪',
  'S6-assemble': '组装',
  'S7-validate': '硬顶校验',
};

export interface StageView {
  name: string;
  label: string;
  tokenCount: number;
}

/** 世界书命中条目视图（含匹配关键词与被裁标记，FR-13） */
export interface WorldBookHitView {
  uid: number;
  matchedKeys: string[];
  matchedSecondary: string[];
  /** 常驻条目：无需关键词匹配 */
  constant: boolean;
  /** kpOnly = 模组真相，只进 prompt */
  kpOnly: boolean;
  /** 预算内（S4 未裁掉） */
  included: boolean;
}

export interface TraceSummary {
  stages: StageView[];
  /** 最终 prompt 总 token（取 S7，缺失时退回各阶段之和） */
  totalTokens: number;
  scan: { scannedMessages: number; entryCount: number };
  budget: {
    budgetTokens: number;
    usedTokens: number;
    includedUids: number[];
    droppedUids: number[];
  };
  hits: WorldBookHitView[];
  history: {
    total: number;
    kept: number;
    trimmed: number;
    synopsisInjected: boolean;
  };
  validate: {
    totalTokens: number;
    hardCap: number | null;
    overBudget: boolean;
    fallbackRounds: number;
  };
  messages: Array<{ role: string; content: string; charCount: number }>;
}

type JsonRecord = Record<string, unknown>;

/**
 * trace.stages[].detail 在线上契约里是 unknown（z.unknown）：管线各阶段形状不同，
 * 且允许以后加字段。这里只做防御式取值，取不到就退回默认，不因缺字段崩界面。
 */
function asRecord(value: unknown): JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function num(source: JsonRecord, key: string, fallback: number): number {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function nullableNum(source: JsonRecord, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function numList(source: JsonRecord, key: string): number[] {
  const value = source[key];
  return Array.isArray(value) ? value.filter((x): x is number => typeof x === 'number') : [];
}

function strList(source: JsonRecord, key: string): string[] {
  const value = source[key];
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}

function bool(source: JsonRecord, key: string): boolean {
  return source[key] === true;
}

/** PipelineTrace → 界面视图：按阶段名取 detail，命中条目带上「是否被裁」 */
export function summarizeTrace(trace: PipelineTracePayload): TraceSummary {
  const details = new Map<string, JsonRecord>();
  const stages: StageView[] = [];
  for (const stage of trace.stages) {
    const detail = asRecord(stage.detail);
    details.set(stage.name, detail);
    stages.push({
      name: stage.name,
      label: STAGE_LABELS[stage.name] ?? stage.name,
      tokenCount: stage.tokenCount,
    });
  }
  const detailOf = (name: string): JsonRecord => details.get(name) ?? {};

  const scan = detailOf('S3-worldbook-scan');
  const budget = detailOf('S4-budget-cut');
  const history = detailOf('S5-history-trim');
  const validate = detailOf('S7-validate');

  const includedUids = numList(budget, 'includedUids');
  const droppedUids = numList(budget, 'droppedUids');
  const rawHits = scan['hits'];

  return {
    stages,
    totalTokens: num(
      validate,
      'totalTokens',
      stages.reduce((sum, stage) => sum + stage.tokenCount, 0),
    ),
    scan: {
      scannedMessages: num(scan, 'scannedMessageCount', 0),
      entryCount: num(scan, 'entryCount', 0),
    },
    budget: {
      budgetTokens: num(budget, 'budgetTokens', 0),
      usedTokens: num(budget, 'usedTokens', 0),
      includedUids,
      droppedUids,
    },
    hits: Array.isArray(rawHits)
      ? rawHits.map((raw) => {
          const hit = asRecord(raw);
          const uid = num(hit, 'uid', -1);
          return {
            uid,
            matchedKeys: strList(hit, 'matchedKeys'),
            matchedSecondary: strList(hit, 'matchedSecondary'),
            constant: bool(hit, 'constant'),
            kpOnly: bool(hit, 'kpOnly'),
            included: includedUids.includes(uid),
          };
        })
      : [],
    history: {
      total: num(history, 'total', 0),
      kept: num(history, 'kept', 0),
      trimmed: num(history, 'trimmed', 0),
      synopsisInjected: bool(history, 'synopsisInjected'),
    },
    validate: {
      totalTokens: num(validate, 'totalTokens', 0),
      hardCap: nullableNum(validate, 'hardCap'),
      overBudget: bool(validate, 'overBudget'),
      fallbackRounds: num(validate, 'fallbackRounds', 0),
    },
    messages: trace.messages.map((message) => ({
      role: message.role,
      content: message.content,
      charCount: message.content.length,
    })),
  };
}

/** 命中条目命中原因：常驻 / 主关键词 / 二级关键词 */
export function formatHitKeywords(hit: WorldBookHitView): string {
  if (hit.constant) return '常驻条目';
  const primary = hit.matchedKeys.join('、');
  const secondary =
    hit.matchedSecondary.length > 0 ? `（二级：${hit.matchedSecondary.join('、')}）` : '';
  return `${primary}${secondary}`;
}

// ---- 数值 / 成本格式化（R-02 防控：让开销一眼可读）----

/** 千分位；非有限值统一显示破折号，不显示 NaN */
export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const digits = Math.round(value).toString();
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 估算费用：小额多给几位小数，避免「¥0.00」把真实开销抹平 */
export function formatCostCny(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const digits = abs === 0 ? 0 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
  return `¥${value.toFixed(digits)}`;
}

/** rate 是 0–1 的小数 */
export function formatPercent(rate: number): string {
  if (!Number.isFinite(rate)) return '—';
  return `${(rate * 100).toFixed(1)}%`;
}

export function formatLatency(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  return ms >= 1_000 ? `${(ms / 1_000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

// ---- 会话展示 ----

export function sessionStateLabel(session: Session): string {
  return session.endedAt === null ? '进行中' : '已结束';
}

/** ISO8601（UTC）→ `YYYY-MM-DD HH:mm UTC`，短到能塞进右栏 */
export function formatIsoShort(iso: string): string {
  return iso.length >= 16 ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : iso;
}

// ---- LLM 参数校验（PATCH /rooms/{id}/sessions/{sid}/settings）----

export interface SessionSettingsPatch {
  temperature?: number;
  maxHistoryMessages?: number;
  worldBookBudgetTokens?: number;
}

/** 表单值一律是字符串（input value），校验后才成数字 */
export interface SettingsDraft {
  temperature: string;
  maxHistoryMessages: string;
  worldBookBudgetTokens: string;
}

export type SettingsFieldErrors = Partial<Record<keyof SettingsDraft, string>>;

export interface SettingsParseResult {
  /** 只含「合法且与当前值不同」的字段；空对象表示无改动，不该发请求 */
  patch: SessionSettingsPatch;
  errors: SettingsFieldErrors;
  ok: boolean;
}

function toNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/**
 * 校验并对齐服务端口径（rooms.ts 的 SessionSettingsPatchSchema）：
 * temperature 0–2、maxHistoryMessages 正整数、worldBookBudgetTokens 非负整数。
 *
 * current 为 null（还没读到会话设置）时不做「是否改动」的比对，照发——
 * KP 在拿不到当前值时也要能把参数写进去。
 */
export function parseSettingsDraft(
  draft: SettingsDraft,
  current: SessionSettings | null,
): SettingsParseResult {
  const errors: SettingsFieldErrors = {};
  const patch: SessionSettingsPatch = {};

  const temperature = toNumber(draft.temperature);
  if (temperature === null) errors.temperature = 'temperature 必须是数字';
  else if (temperature < 0 || temperature > 2) errors.temperature = 'temperature 需在 0–2 之间';
  else if (current === null || current.temperature !== temperature) patch.temperature = temperature;

  const maxHistoryMessages = toNumber(draft.maxHistoryMessages);
  if (maxHistoryMessages === null) errors.maxHistoryMessages = '裁剪窗必须是数字';
  else if (!Number.isInteger(maxHistoryMessages) || maxHistoryMessages <= 0)
    errors.maxHistoryMessages = '裁剪窗必须是正整数';
  else if (current === null || current.maxHistoryMessages !== maxHistoryMessages)
    patch.maxHistoryMessages = maxHistoryMessages;

  const worldBookBudgetTokens = toNumber(draft.worldBookBudgetTokens);
  if (worldBookBudgetTokens === null) errors.worldBookBudgetTokens = '世界书预算必须是数字';
  else if (!Number.isInteger(worldBookBudgetTokens) || worldBookBudgetTokens < 0)
    errors.worldBookBudgetTokens = '世界书预算必须是非负整数';
  else if (current === null || current.worldBookBudgetTokens !== worldBookBudgetTokens)
    patch.worldBookBudgetTokens = worldBookBudgetTokens;

  return { patch, errors, ok: Object.keys(errors).length === 0 };
}
