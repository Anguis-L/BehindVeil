import { describe, expect, it } from 'vitest';
import { LlmRuntime, maskApiKey } from './runtime.js';
import { createMockLlm } from './mock.js';

/**
 * LLM 运行时配置（2026-10-08 可用性改造）。
 *
 * 守的是三条不能让步的口径：
 * ① 密钥永不回显（NFR-03）② 改坏了要回滚，不能把 AI 弄瘫 ③ 测试注入期间锁死不可改。
 */

const BASE = {
  provider: 'openai-compat',
  model: 'm1',
  baseUrl: 'https://llm.test/v1',
  timeoutMs: 1000,
  maxTokens: 512,
  apiKey: 'sk-secret-abcdefgh',
};

describe('maskApiKey', () => {
  it('只留首尾各 4 位，中间全遮', () => {
    expect(maskApiKey('sk-abcdefgh1234')).toBe('sk-a••••1234');
  });

  it('短 key 全遮、空 key 给空串', () => {
    expect(maskApiKey('abc')).toBe('••••••');
    expect(maskApiKey(undefined)).toBe('');
    expect(maskApiKey('')).toBe('');
  });
});

describe('LlmRuntime snapshot', () => {
  it('对外只给「有没有 key + 打码串」，绝不回传明文', () => {
    const snap = new LlmRuntime(BASE).snapshot();
    expect(snap.hasApiKey).toBe(true);
    expect(snap.apiKeyHint).not.toContain('secret');
    expect(snap.apiKeyHint).not.toContain('abcdefgh');
    expect(JSON.stringify(snap)).not.toContain('sk-secret');
  });

  it('装配成功即 ready，来源是配置文件/环境变量', () => {
    const snap = new LlmRuntime(BASE).snapshot();
    expect(snap.ready).toBe(true);
    expect(snap.adapterId).toBe('openai-compat');
    expect(snap.source).toBe('env');
  });

  it('装配失败：ready=false 并给出原因，但不抛错（AI 停用而非服务起不来）', () => {
    const snap = new LlmRuntime({ ...BASE, baseUrl: undefined }).snapshot();
    expect(snap.ready).toBe(false);
    expect(snap.error).toContain('baseUrl');
  });
});

describe('LlmRuntime patch', () => {
  it('热更成功：新适配器生效，来源标记为 runtime', () => {
    const rt = new LlmRuntime(BASE);
    const res = rt.patch({ model: 'm2', baseUrl: 'https://other.test/v1' });
    expect(res.ok).toBe(true);
    expect(rt.model()).toBe('m2');
    expect(rt.snapshot().source).toBe('runtime');
    expect(rt.current()?.id).toBe('openai-compat');
  });

  it('新配置不可用 → 回滚并给原因，旧适配器继续服务（不能把 AI 弄瘫）', () => {
    const rt = new LlmRuntime(BASE);
    const before = rt.current();
    const res = rt.patch({ baseUrl: '' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain('已保留原设置');
    expect(rt.current()).toBe(before);
    expect(rt.snapshot().ready).toBe(true);
    expect(rt.model()).toBe('m1');
  });

  it('apiKey 空串 = 清除密钥', () => {
    const rt = new LlmRuntime(BASE);
    expect(rt.patch({ apiKey: '' }).ok).toBe(true);
    expect(rt.snapshot().hasApiKey).toBe(false);
  });

  it('注入适配器（测试/E2E）期间锁定，页面改不动', () => {
    const rt = new LlmRuntime(BASE, { injected: createMockLlm() });
    expect(rt.snapshot().locked).toBe(true);
    expect(rt.snapshot().adapterId).toBe('mock');
    const res = rt.patch({ model: 'hacked' });
    expect(res.ok).toBe(false);
    expect(rt.model()).toBe('m1');
  });
});

describe('LlmRuntime test', () => {
  it('连不上时给人话原因，而不是原始堆栈', async () => {
    const rt = new LlmRuntime({ ...BASE, baseUrl: 'http://127.0.0.1:1/v1', timeoutMs: 2000 });
    const res = await rt.test();
    expect(res.ok).toBe(false);
    expect(res.message).toContain('连不上');
  });

  it('临时配置只用于探活，不落到运行时', async () => {
    const rt = new LlmRuntime(BASE);
    await rt.test({ model: 'probe-only', baseUrl: 'http://127.0.0.1:1/v1' });
    expect(rt.model()).toBe('m1');
    expect(rt.snapshot().baseUrl).toBe('https://llm.test/v1');
  });

  it('provider=mock 的探活走 mock 适配器（不拿真实端点去试）', async () => {
    const rt = new LlmRuntime({ ...BASE, provider: 'mock', model: 'mock-1' });
    const res = await rt.test();
    expect(res.ok).toBe(true);
  });
});
