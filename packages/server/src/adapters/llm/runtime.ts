/**
 * LLM 运行时配置（2026-10-08 可用性改造）。
 *
 * 背景：换模型此前只有一条路——手改 `data/config.yaml` + 环境变量 `AIDLE_LLM_KEY`
 * 再**重启进程**。对自托管的非技术用户等于「不会换」。本文件把 provider/model/baseUrl/
 * timeoutMs/maxTokens/apiKey 变成进程内可热更的状态：页面改完下一次 AI 调用即生效。
 *
 * 三条不可让步的红线（与 NFR-03 同源）：
 * 1. **key 永不落盘**：只活在本对象内存里，不写 config.yaml、不写日志、不随任何响应回传
 *    （对外只给 `hasApiKey` + `apiKeyHint` 打码串）；
 * 2. **改坏了不能把 AI 弄瘫**：patch 先拿新设置试构造适配器，构造失败即**回滚**并返回原因，
 *    原有适配器继续工作（与「宁可拒绝，不静默猜」的项目口径一致）；
 * 3. **测试注入优先**：`opts.llm` 注入的适配器（E2E 剧本化 Mock）期间锁定，页面不可改。
 */

import type { LlmAdapter } from '../../domain/llm.js';
import { createLlmAdapter } from './index.js';
import { createMockLlm } from './mock.js';

export interface LlmRuntimeSettings {
  provider: string;
  model: string;
  baseUrl?: string;
  timeoutMs: number;
  maxTokens: number;
  apiKey?: string;
}

/** 对外可见的运行时状态：不含明文 key（NFR-03） */
export interface LlmRuntimeSnapshot {
  provider: string;
  model: string;
  baseUrl: string;
  timeoutMs: number;
  maxTokens: number;
  hasApiKey: boolean;
  /** 打码提示（如 `sk-a••••7f2c`），无 key 为空串——仅用于「我填的是不是这一把」的确认 */
  apiKeyHint: string;
  /** 适配器当前可用（AI 能真正跑起来） */
  ready: boolean;
  adapterId: string | undefined;
  /** 适配器不可用时的原因（装配失败信息），可用时为 undefined */
  error: string | undefined;
  /** env=来自 config.yaml/环境变量；runtime=页面改过 */
  source: 'env' | 'runtime';
  /** true = 适配器由装配参数注入（测试/E2E），页面只读 */
  locked: boolean;
}

export type LlmRuntimePatch = Partial<Omit<LlmRuntimeSettings, 'apiKey'>> & {
  /** 空串 = 清除已填的 key */
  apiKey?: string;
};

export interface LlmRuntimeTestResult {
  ok: boolean;
  latencyMs: number;
  model: string;
  /** 失败原因（人话，直接给页面显示） */
  message?: string;
}

/** 探活超时上限：用户填错地址时不该让页面转 60 秒（config 默认 60s 是给长叙事用的） */
const PROBE_TIMEOUT_MS = 15_000;

/** key 打码：只留首 4 与末 4，中间全遮 */
export function maskApiKey(key: string | undefined): string {
  if (key === undefined || key === '') return '';
  if (key.length <= 8) return '••••••';
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

function buildAdapter(settings: LlmRuntimeSettings): LlmAdapter {
  if (settings.provider === 'mock') return createMockLlm();
  return createLlmAdapter({
    provider: settings.provider,
    model: settings.model,
    baseUrl: settings.baseUrl,
    timeoutMs: settings.timeoutMs,
    maxTokens: settings.maxTokens,
    apiKey: settings.apiKey,
  });
}

export class LlmRuntime {
  private settings: LlmRuntimeSettings;
  private adapter: LlmAdapter | undefined;
  private adapterError: string | undefined;
  private source: 'env' | 'runtime' = 'env';
  private readonly locked: boolean;

  constructor(initial: LlmRuntimeSettings, opts: { injected?: LlmAdapter } = {}) {
    this.settings = { ...initial };
    this.locked = opts.injected !== undefined;
    if (this.locked) {
      // 注入场景（T-M5-11 E2E）：适配器与配置都不是本对象的职责，原样透出
      this.adapter = opts.injected;
      return;
    }
    this.rebuild(this.settings);
  }

  /** 当前生效的适配器；装配失败时为 undefined（AI 停用，与既有口径一致） */
  current(): LlmAdapter | undefined {
    return this.adapter;
  }

  /** 当前模型名（网关 chat 参数用；热更后要重新取，不能启动时快照） */
  model(): string {
    return this.settings.model;
  }

  maxTokens(): number {
    return this.settings.maxTokens;
  }

  snapshot(): LlmRuntimeSnapshot {
    return {
      provider: this.settings.provider,
      model: this.settings.model,
      baseUrl: this.settings.baseUrl ?? '',
      timeoutMs: this.settings.timeoutMs,
      maxTokens: this.settings.maxTokens,
      hasApiKey: this.settings.apiKey !== undefined && this.settings.apiKey !== '',
      apiKeyHint: maskApiKey(this.settings.apiKey),
      ready: this.adapter !== undefined,
      adapterId: this.adapter?.id,
      error: this.adapterError,
      source: this.source,
      locked: this.locked,
    };
  }

  /**
   * 局部更新并重建适配器。失败即回滚（旧适配器继续服务），返回人话原因。
   */
  patch(
    patch: LlmRuntimePatch,
  ): { ok: true; snapshot: LlmRuntimeSnapshot } | { ok: false; message: string } {
    if (this.locked) return { ok: false, message: '当前 LLM 适配器由启动参数注入，页面不可修改' };

    const next: LlmRuntimeSettings = { ...this.settings };
    if (patch.provider !== undefined) next.provider = patch.provider;
    if (patch.model !== undefined) next.model = patch.model;
    if (patch.baseUrl !== undefined) next.baseUrl = patch.baseUrl;
    if (patch.timeoutMs !== undefined) next.timeoutMs = patch.timeoutMs;
    if (patch.maxTokens !== undefined) next.maxTokens = patch.maxTokens;
    if (patch.apiKey !== undefined) {
      next.apiKey = patch.apiKey === '' ? undefined : patch.apiKey;
    }

    let built: LlmAdapter;
    try {
      built = buildAdapter(next);
    } catch (err) {
      return {
        ok: false,
        message: `新配置不可用，已保留原设置：${err instanceof Error ? err.message : String(err)}`,
      };
    }

    this.settings = next;
    this.adapter = built;
    this.adapterError = undefined;
    this.source = 'runtime';
    return { ok: true, snapshot: this.snapshot() };
  }

  /**
   * 连通性自检：拿当前（或请求体给出的临时）配置发一条最小 chat 请求。
   * 临时配置**不落库**——填完先试、通了再保存，避免「保存了一个连不上的配置」。
   */
  async test(override?: LlmRuntimePatch): Promise<LlmRuntimeTestResult> {
    const settings: LlmRuntimeSettings = { ...this.settings, ...sanitize(override) };
    const started = Date.now();
    try {
      // 与 patch 走同一个构造出口（buildAdapter）：否则 provider=mock / ollama 会被
      // 当成 openai-compat 去连真实端点，探活结果与真正生效的适配器不一致。
      const probe = buildAdapter({
        ...settings,
        timeoutMs: Math.min(settings.timeoutMs, PROBE_TIMEOUT_MS),
      });
      const res = await probe.chat(
        {
          messages: [{ role: 'user', content: 'ping' }],
          model: settings.model,
          temperature: 0,
          maxTokens: 1,
        },
        () => undefined,
      );
      return { ok: true, latencyMs: Date.now() - started, model: settings.model || res.content };
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        latencyMs: Date.now() - started,
        model: settings.model,
        message: humanize(raw),
      };
    }
  }

  /** 内部：按当前设置重建（构造期 / 回滚用） */
  private rebuild(next: LlmRuntimeSettings): void {
    try {
      this.adapter = buildAdapter(next);
      this.adapterError = undefined;
    } catch (err) {
      this.adapter = undefined;
      this.adapterError = err instanceof Error ? err.message : String(err);
    }
  }
}

/** 只保留真正给了的字段（undefined 不覆盖） */
function sanitize(patch: LlmRuntimePatch | undefined): LlmRuntimePatch {
  if (!patch) return {};
  const out: LlmRuntimePatch = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

/** 把适配器/网络层的英文报错翻成人话（页面直接显示） */
function humanize(raw: string): string {
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|EAI_AGAIN/i.test(raw)) {
    return `连不上这个地址（${raw}）——检查接口地址是否填对、网络是否可达`;
  }
  if (/401|Unauthorized|invalid api key|Incorrect API key/i.test(raw)) {
    return '密钥被拒绝（401）——检查密钥是否填对、是否过期';
  }
  if (/404|not found/i.test(raw)) {
    return '地址或模型不存在（404）——检查接口地址与模型名';
  }
  if (/timeout|ETIMEDOUT|aborted/i.test(raw)) {
    return '请求超时——检查网络，或把超时时间调大一点';
  }
  return raw;
}
