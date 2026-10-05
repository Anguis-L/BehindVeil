import type {
  CharacterCardV3,
  Message,
  SessionSettings,
  StateBoard,
  WorldBook,
} from '@behindveil/shared';
import type { LlmMessage } from '../domain/llm.js';
import type { Tokenizer } from './tokenizer.js';

/**
 * Prompt 管线类型（T-M0-07，TDD §5.1）。
 * PipelineTrace 全量可 JSON 序列化：KP 预览（FR-13）与黄金用例快照（tests/golden/）
 * 共用同一形状；管线行为变更必须显式更新黄金用例。
 */

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface PipelineInput {
  session: SessionSettings;
  kpCard: CharacterCardV3;
  /** 全量消息，未裁剪 */
  messages: Message[];
  stateBoard: StateBoard;
  worldBook: WorldBook;
  /** PC 名册文本（M3 前为手编/内存桩，T-M5-04 起由状态板名册生成） */
  pcRoster: string;
  /**
   * 剧情梗概（决议 D-01）：历史被裁部分以梗概块替代，v1 由 Host 手编 session.json
   * 的 synopsis 字段维护（载入时过 Schema 校验）；AI 生成留二期。
   */
  synopsis: string;
  /**
   * 向量召回结果（v3 FR-33 / ADR-3-03，可选）：S3 关键词扫描后的 topK 并集输入，
   * 由召回服务在管线外异步准备（查询嵌入是网络调用，管线保持同步纯函数）。
   * 缺省 = 未配置嵌入/本轮降级 → S3.5 整段跳过，行为与 v2.0 逐字节一致（可关断红线）。
   */
  vectorRecall?: {
    hits: Array<{ uid: number; score: number }>;
    meta: VectorRecallMeta;
    /** true = 已配置嵌入但本轮嵌入失败：S3.5 trace 告警，零并集 = 纯关键词 */
    degraded?: boolean;
    degradedReason?: string;
  };
}

/** S3.5 召回过程元数据（进 trace，可观测红线） */
export interface VectorRecallMeta {
  /** 本轮实际调用嵌入的条目数（内容变更/首次） */
  embeddedEntries: number;
  /** 缓存命中（hash 相等跳过嵌入）的条目数 */
  reusedEntries: number;
  /** 索引内存占用估算（字节） */
  memoryBytes: number;
  /** 超 64MB 硬顶后按 weight 截断过 */
  truncatedForMemory: boolean;
}

export const PIPELINE_STAGES = [
  'S1-skeleton',
  'S2-state',
  'S3-worldbook-scan',
  'S3.5-vector-recall',
  'S4-budget-cut',
  'S5-history-trim',
  'S6-assemble',
  'S7-validate',
] as const;
export type StageName = (typeof PIPELINE_STAGES)[number];

export interface StageTrace {
  name: StageName;
  /** 该阶段主要产物的 token 估算（经注入的 Tokenizer） */
  tokenCount: number;
  detail: JsonValue;
}

export interface PipelineTrace {
  stages: StageTrace[];
  /** 最终产物（S6 输出）；总 token 数见 S7 detail */
  messages: LlmMessage[];
}

export interface PipelineDeps {
  tokenizer: Tokenizer;
}
