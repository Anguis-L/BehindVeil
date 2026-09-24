import { OpenAiCompatAdapter } from './openai-compat.js';
import type { LlmAdapter } from '../../domain/llm.js';

/**
 * Ollama 适配器（T-M0-09，TDD §7）：OpenAI 兼容协议直连本地端点，免 key
 * （永不发送 Authorization，即使环境变量里有 key），超时放宽（本地推理慢）。
 */
export const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434/v1';
/** 默认 5 分钟：本地大模型长 prompt 推理可能远慢于云端（TDD §7「超时放宽」） */
export const OLLAMA_DEFAULT_TIMEOUT_MS = 300_000;

export interface OllamaConfig {
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  /** fetch 注入点（测试用） */
  fetchImpl?: typeof fetch;
}

class OllamaAdapter extends OpenAiCompatAdapter {
  override readonly id = 'ollama';
}

export function createOllamaAdapter(config: OllamaConfig = {}): LlmAdapter {
  return new OllamaAdapter({
    baseUrl: config.baseUrl ?? OLLAMA_DEFAULT_BASE_URL,
    model: config.model,
    timeoutMs: config.timeoutMs ?? OLLAMA_DEFAULT_TIMEOUT_MS,
    fetchImpl: config.fetchImpl,
  });
}
