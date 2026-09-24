import {
  LlmError,
  type ChatFinishReason,
  type ChatRequest,
  type ChatResponse,
  type ChatUsage,
  type LlmAdapter,
} from '../../domain/llm.js';

/**
 * OpenAI 兼容协议适配器（T-M0-08，TDD §7 / FR-03）。
 * 覆盖 DeepSeek / GLM / Qwen / Kimi / OpenAI 等 /v1/chat/completions 兼容端点。
 *
 * - 5xx / 超时（未收到任何增量前）：指数退避重试 2 次，耗尽后抛 E-LLM-01（TDD §7/§11）
 * - 流中断（已收到增量）：保留已收增量 + finishReason='aborted'（E-LLM-02），不重试
 * - key 只存在于本层，调用方不得将其写入日志/预览（NFR-03，出口一律经 redact）
 */

/** 内部标记：可重试失败（5xx / 未收增量前的超时 / 网络错误） */
class RetryableError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'RetryableError';
    this.status = status;
  }
}

export interface OpenAiCompatConfig {
  /** 兼容端点根，如 https://api.deepseek.com/v1（尾部斜杠自动去除） */
  baseUrl: string;
  /** 缺省时不发送 Authorization 头（本地网关场景） */
  apiKey?: string;
  /** 覆盖 ChatRequest.model（Ollama 等需要指定本地模型时使用） */
  model?: string;
  /** 单次尝试超时 ms（覆盖连接到流结束的全程），默认 60s */
  timeoutMs?: number;
  /** 退避基数 ms：第 n 次重试等待 retryDelayMs * 2^n，默认 500 */
  retryDelayMs?: number;
  /** 重试次数（E-LLM-01 定为 2），默认 2 */
  maxRetries?: number;
  /** fetch 注入点：契约对拍 mock HTTP server（TC-FR-03-001）与超时测试用 */
  fetchImpl?: typeof fetch;
}

interface SseChunk {
  choices?: Array<{
    delta?: { content?: string };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAiCompatAdapter implements LlmAdapter {
  readonly id: string = 'openai-compat';

  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly modelOverride: string | undefined;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: OpenAiCompatConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.modelOverride = config.model;
    this.timeoutMs = config.timeoutMs ?? 60_000;
    this.retryDelayMs = config.retryDelayMs ?? 500;
    this.maxRetries = config.maxRetries ?? 2;
    this.fetchImpl = config.fetchImpl ?? fetch.bind(globalThis);
  }

  async chat(req: ChatRequest, onDelta: (delta: string) => void): Promise<ChatResponse> {
    let lastError: unknown = new LlmError('E-LLM-01', 'LLM 请求未发起');
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.attemptOnce(req, onDelta);
      } catch (err) {
        lastError = err;
        if (!(err instanceof RetryableError) || attempt === this.maxRetries) break;
        await delay(this.retryDelayMs * 2 ** attempt);
      }
    }
    throw toLlmError(lastError);
  }

  private async attemptOnce(
    req: ChatRequest,
    onDelta: (delta: string) => void,
  ): Promise<ChatResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let receivedDelta = false;
    let content = '';
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.modelOverride ?? req.model,
          messages: req.messages,
          temperature: req.temperature,
          max_tokens: req.maxTokens,
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = (await res.text().catch(() => '')).slice(0, 200);
        if (res.status >= 500) {
          throw new RetryableError(`provider 返回 ${res.status}：${body}`, res.status);
        }
        throw new LlmError('E-LLM-01', `provider 拒绝请求（${res.status}）：${body}`, {
          status: res.status,
          retryable: false,
        });
      }
      if (!res.body) throw new RetryableError('provider 未返回响应体');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finishReason: ChatFinishReason = 'stop';
      let usage: ChatUsage | undefined;
      let streamDone = false;

      const consumeLine = (rawLine: string): void => {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) return;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          streamDone = true;
          return;
        }
        let chunk: SseChunk;
        try {
          chunk = JSON.parse(payload) as SseChunk;
        } catch {
          return; // 坏块容忍：跳过，不影响后续增量
        }
        const choice = chunk.choices?.[0];
        const delta = choice?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) {
          receivedDelta = true;
          content += delta;
          onDelta(delta);
        }
        if (choice?.finish_reason === 'length') finishReason = 'length';
        if (chunk.usage) {
          usage = {
            promptTokens: chunk.usage.prompt_tokens ?? 0,
            completionTokens: chunk.usage.completion_tokens ?? 0,
          };
        }
      };

      while (!streamDone) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) consumeLine(line);
      }
      if (!streamDone && buffer.length > 0) consumeLine(buffer);
      if (!streamDone) {
        // 提前断流（连接关闭但从未收到 [DONE]）：
        // 已有增量 → E-LLM-02 保留并标记中断；无增量 → 视同网络失败走重试
        if (content.length > 0) {
          return { content, finishReason: 'aborted', aborted: true };
        }
        throw new RetryableError('provider 提前关闭了响应流');
      }

      return { content, finishReason, aborted: false, ...(usage ? { usage } : {}) };
    } catch (err) {
      if (receivedDelta) {
        // E-LLM-02：流中断——保留已收增量 + 中断标记，不重试
        return { content, finishReason: 'aborted', aborted: true };
      }
      if (err instanceof LlmError || err instanceof RetryableError) throw err;
      throw new RetryableError(describeError(err));
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 工厂入口（TDD §7）；Ollama 适配器复用同一实现 */
export function createOpenAiCompatAdapter(config: OpenAiCompatConfig): OpenAiCompatAdapter {
  return new OpenAiCompatAdapter(config);
}

function toLlmError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  const status = err instanceof RetryableError ? err.status : undefined;
  return new LlmError('E-LLM-01', err instanceof Error ? err.message : String(err), {
    status,
    retryable: true,
  });
}

function describeError(err: unknown): string {
  if (err instanceof Error && err.name === 'AbortError') return 'provider 请求超时';
  return err instanceof Error ? err.message : String(err);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
