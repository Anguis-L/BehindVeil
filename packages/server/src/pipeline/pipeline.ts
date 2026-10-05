import {
  s1Skeleton,
  s2State,
  s35VectorRecall,
  s3WorldbookScan,
  s4BudgetCut,
  s5HistoryTrim,
  s6Assemble,
  s7Validate,
  type PipelineBundle,
  type Stage,
} from './stages.js';
import type { Tokenizer } from './tokenizer.js';
import type { PipelineInput, PipelineTrace, StageTrace } from './types.js';

/**
 * Prompt 管线（T-M0-07，TDD §5.1）：S1–S7 纯函数链，每阶段记录 trace。
 * 依赖注入：tokenizer 由调用方传入，本模块不 import adapters（TDD §1.2）。
 * v3 起支持 S3.5（向量召回并集）：仅当 input.vectorRecall 存在（已配置嵌入且
 * 本轮未降级）时插入执行——缺省阶段序列与 v2.0 逐字节一致（可关断红线）。
 */

/** v2.0 基础阶段顺序（TDD §5.1） */
export const STAGE_ORDER: readonly Stage[] = [
  s1Skeleton,
  s2State,
  s3WorldbookScan,
  s4BudgetCut,
  s5HistoryTrim,
  s6Assemble,
  s7Validate,
];

/** 组装 prompt（TDD §5.1 buildPrompt）：相同输入产出相同 trace（纯函数，黄金用例前提） */
export function buildPrompt(input: PipelineInput, tokenizer: Tokenizer): PipelineTrace {
  const bundle: PipelineBundle = {
    skeleton: '',
    stateBlock: '',
    scanHits: [],
    worldbookBlocks: [],
    history: [],
    synopsis: '',
    messages: [],
  };
  const ctx = { input, bundle, tokenizer };
  const stages: Stage[] = [...STAGE_ORDER];
  if (input.vectorRecall !== undefined) {
    stages.splice(3, 0, s35VectorRecall); // S3 之后、S4 之前（设计 §5.3「S3.5」）
  }
  const traces: StageTrace[] = stages.map((stage) => stage(ctx));
  return { stages: traces, messages: bundle.messages };
}
