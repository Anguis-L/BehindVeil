import type { ErrorCode } from '@behindveil/shared';

/**
 * LLM 端口（T-M0-08，TDD §7）。
 *
 * 接口定义在 domain 层：adapters/llm 实现它，pipeline / ai-directive（M3）只依赖
 * 本文件类型，满足「pipeline 不 import adapters（通过接口注入）」的依赖方向（TDD §1.2）。
 * 接口恒为流式（TDD §7 ChatRequest 的 stream:true）：增量经 onDelta 回调交付。
 */

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  messages: LlmMessage[];
  model: string;
  temperature: number;
  maxTokens: number;
  /** 本接口恒为流式（TDD §7）；字段仅为契约自描述，适配器不读 */
  stream?: true;
}

export type ChatFinishReason =
  | 'stop'
  | 'length'
  /** E-LLM-02 流中断：content 为已收增量，UI 显示「生成中断」 */
  | 'aborted';

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface ChatResponse {
  /** 全量拼接文本；流中断时为已收增量（保留，E-LLM-02） */
  content: string;
  finishReason: ChatFinishReason;
  /** true = 流中断（E-LLM-02）；与 finishReason='aborted' 同义，便于消费方直读 */
  aborted: boolean;
  usage?: ChatUsage;
}

export interface LlmAdapter {
  /** 适配器标识：'openai-compat' | 'ollama' | 'mock' */
  readonly id: string;
  chat(req: ChatRequest, onDelta: (delta: string) => void): Promise<ChatResponse>;
}

/**
 * provider 侧错误（E-LLM-01：重试耗尽或不可重试的失败）。
 * 流中断不抛错——以 ChatResponse.finishReason='interrupted' 返回（E-LLM-02）。
 */
export class LlmError extends Error {
  readonly code: ErrorCode;
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { status?: number; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
  }
}
