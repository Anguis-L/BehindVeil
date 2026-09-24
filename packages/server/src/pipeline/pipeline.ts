import {
  s1Skeleton,
  s2State,
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
 */

/** 阶段执行顺序（TDD §5.1），trace.stages 依此排列 */
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
    worldbookBlocks: [],
    history: [],
    synopsis: '',
    messages: [],
  };
  const ctx = { input, bundle, tokenizer };
  const stages: StageTrace[] = STAGE_ORDER.map((stage) => stage(ctx));
  return { stages, messages: bundle.messages };
}
