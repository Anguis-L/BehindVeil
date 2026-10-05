import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createEmbedAdapter } from './index.js';
import { createMockLlm } from './mock.js';
import { createOpenAiCompatAdapter } from './openai-compat.js';
import { createOllamaAdapter } from './ollama.js';
import { LlmError } from '../../domain/llm.js';

/**
 * embed 契约（v3 T-M11-01，FR-33 / ADR-3-01）：
 * 请求形状对拍（mock HTTP server）、重试语义（5xx 退避重试 / 4xx 不重试）、
 * 条数与顺序对齐、未配置嵌入模型时的明确拒绝、mock 的确定性字符袋向量。
 */

interface EmbedRequest {
  model?: string;
  input?: string[];
  auth?: string;
}

/** 最小嵌入端点 mock：按调用序返回预置响应，记录请求体供断言 */
async function embeddingServer(
  responses: Array<{ status: number; body: unknown }>,
): Promise<{ url: string; requests: EmbedRequest[]; close(): Promise<void> }> {
  const requests: EmbedRequest[] = [];
  let call = 0;
  const srv: Server = createHttpServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => {
      raw += String(c);
    });
    req.on('end', () => {
      const response = responses[Math.min(call, responses.length - 1)] as {
        status: number;
        body: unknown;
      };
      call += 1;
      const parsed = JSON.parse(raw) as { model?: string; input?: string[] };
      requests.push({ model: parsed.model, input: parsed.input, auth: req.headers.authorization });
      res.writeHead(response.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response.body));
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = (srv.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        srv.close(() => resolve());
      }),
  };
}

describe('OpenAI 兼容 embed 契约', () => {
  it('POST /embeddings 携带 model+input 与 Bearer key；返回按 index 对齐', async () => {
    const srv = await embeddingServer([
      {
        status: 200,
        body: {
          data: [
            { index: 1, embedding: [0, 1] },
            { index: 0, embedding: [1, 0] },
          ],
        },
      },
    ]);
    try {
      const adapter = createOpenAiCompatAdapter({
        baseUrl: srv.url,
        apiKey: 'sk-test',
        embedModel: 'text-embed-1',
        fetchImpl: fetch,
      });
      const vectors = await adapter.embed(['雾桥', '驿站']);
      expect(vectors).toHaveLength(2);
      expect([...(vectors[0] as Float32Array)]).toEqual([1, 0]); // index 0 对齐第一条输入
      expect([...(vectors[1] as Float32Array)]).toEqual([0, 1]);
      expect(srv.requests[0]?.model).toBe('text-embed-1');
      expect(srv.requests[0]?.input).toEqual(['雾桥', '驿站']);
      expect(srv.requests[0]?.auth).toBe('Bearer sk-test');
    } finally {
      await srv.close();
    }
  });

  it('5xx 指数退避重试后成功；4xx 不重试直接 E-LLM-01', async () => {
    const flaky = await embeddingServer([
      { status: 500, body: { error: 'boom' } },
      { status: 200, body: { data: [{ index: 0, embedding: [1] }] } },
    ]);
    const rejected = await embeddingServer([{ status: 401, body: { error: 'bad key' } }]);
    try {
      const adapter = createOpenAiCompatAdapter({
        baseUrl: flaky.url,
        embedModel: 'e',
        retryDelayMs: 1,
        fetchImpl: fetch,
      });
      const vectors = await adapter.embed(['x']);
      expect(vectors[0]?.[0]).toBe(1);

      const strict = createOpenAiCompatAdapter({
        baseUrl: rejected.url,
        embedModel: 'e',
        fetchImpl: fetch,
      });
      await expect(strict.embed(['x'])).rejects.toMatchObject({
        code: 'E-LLM-01',
        retryable: false,
      });
    } finally {
      await flaky.close();
      await rejected.close();
    }
  });

  it('未配置 embedModel：embed 明确拒绝（向量召回按未配置处理）', async () => {
    const adapter = createOpenAiCompatAdapter({ baseUrl: 'http://127.0.0.1:9', fetchImpl: fetch });
    await expect(adapter.embed(['x'])).rejects.toMatchObject({
      code: 'E-LLM-01',
      retryable: false,
    });
  });

  it('空输入直接返回空数组，不发起请求', async () => {
    const adapter = createOpenAiCompatAdapter({
      baseUrl: 'http://127.0.0.1:9',
      embedModel: 'e',
      fetchImpl: fetch,
    });
    expect(await adapter.embed([])).toEqual([]);
  });
});

describe('装配出口与 Ollama / Mock', () => {
  it('createEmbedAdapter：openai-compat 需 baseUrl；ollama 有默认端点', () => {
    expect(() => createEmbedAdapter({ provider: 'openai-compat', model: 'e' })).toThrow(
      /embedding\.baseUrl/,
    );
    const ollama = createEmbedAdapter({ provider: 'ollama', model: 'nomic-embed' });
    expect(ollama.id).toBe('ollama');
    expect(typeof ollama.embed).toBe('function');
  });

  it('createOllamaAdapter 透传 embedModel（/v1/embeddings 同形状）', async () => {
    const adapter = createOllamaAdapter({
      baseUrl: 'http://127.0.0.1:9/v1',
      embedModel: 'nomic-embed-text',
      fetchImpl: fetch,
    });
    const embed = adapter.embed;
    if (!embed) throw new Error('ollama 适配器应恒具备 embed 能力（/v1/embeddings 同形状）');
    // call 绑定 this：embed 是实例方法，抽出变量直接调会丢了适配器上下文
    await expect(embed.call(adapter, ['x'])).rejects.toMatchObject({ code: 'E-LLM-01' });
  });

  it('MockLlm：配置 embedDim 才有 embed；字符袋语义（共享字符 → 更高余弦）且确定性', async () => {
    const without = createMockLlm({ script: [] });
    await expect(without.embed(['x'])).rejects.toBeInstanceOf(LlmError);

    const mock = createMockLlm({ script: [], embedDim: 16 });
    const [a, a2, b] = await mock.embed(['灯塔在雾中', '灯塔在雾中', ' completely different']);
    expect([...(a as Float32Array)]).toEqual([...(a2 as Float32Array)]);

    const dot = (u: Float32Array, v: Float32Array): number =>
      [...u].reduce((sum, x, i) => sum + x * (v[i] as number), 0);
    expect(dot(a as Float32Array, a2 as Float32Array)).toBeCloseTo(1, 6);
    expect(dot(a as Float32Array, b as Float32Array)).toBeLessThan(0.5);
  });
});
