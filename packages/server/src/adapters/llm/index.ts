/**
 * LLM 适配器装配出口（TDD §7）：按配置选择 provider 实现。
 *
 * provider 编辑点 = data/config.yaml 的 llm 段（provider/model/baseUrl/timeoutMs），
 * key 只走环境变量 AIDLE_LLM_KEY（NFR-03，永不落盘）；控制台在线编辑随 T-M6-04。
 * 凡兼容 /v1/chat/completions 的端点（DeepSeek/GLM/Qwen/Kimi/SenseNova…）
 * 均走 openai-compat，无需为新增 provider 改代码。
 */
import type { LlmAdapter } from '../../domain/llm.js';
import { createOpenAiCompatAdapter } from './openai-compat.js';
import { createOllamaAdapter } from './ollama.js';

export * from './openai-compat.js';
export * from './ollama.js';
export * from './mock.js';

/** provider 装配所需的配置形状（config.ts 的 LlmConfig 天然满足） */
export interface LlmProviderConfig {
  /** 'openai-compat' | 'ollama'；其余兼容端点值也按 openai-compat 处理 */
  provider: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxTokens?: number;
  apiKey?: string;
}

export function createLlmAdapter(cfg: LlmProviderConfig): LlmAdapter {
  if (cfg.provider === 'ollama') {
    return createOllamaAdapter({
      baseUrl: cfg.baseUrl,
      model: cfg.model || undefined,
      timeoutMs: cfg.timeoutMs,
    });
  }
  if (!cfg.baseUrl) {
    throw new Error(
      `provider "${cfg.provider}" 需要在配置中提供 llm.baseUrl（兼容端点根，如 https://api.deepseek.com/v1）`,
    );
  }
  return createOpenAiCompatAdapter({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.model || undefined,
    timeoutMs: cfg.timeoutMs,
  });
}
