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
}

export const PIPELINE_STAGES = [
  'S1-skeleton',
  'S2-state',
  'S3-worldbook-scan',
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
