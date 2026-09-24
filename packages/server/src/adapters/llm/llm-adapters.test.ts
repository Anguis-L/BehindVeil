import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockLlm } from './mock.js';
import { createOpenAiCompatAdapter } from './openai-compat.js';
import { createOllamaAdapter, OLLAMA_DEFAULT_BASE_URL } from './ollama.js';

/**
 * T-M0-08 / T-M0-09：LLM 适配器（TDD §7）。
 * 覆盖 TC-FR-03-001（双 provider 对拍结构同构）与 TC-FR-03-002（退避重试 / 流中断）。
 * 所有用例对本地 mock HTTP server（SSE）运行，无需真实 key。
 */

interface MockRequest {
  body: string;
  headers: Record<string, unknown>;
}

interface MockServer {
  url: string;
  requests: MockRequest[];
  close: () => Promise<void>;
}

type MockHandler = (ctx: {
  attempt: number;
  body: string;
  headers: Record<string, unknown>;
  res: ServerResponse;
}) => void;

const open: MockServer[] = [];

async function startMockServer(handler: MockHandler): Promise<MockServer> {
  const requests: MockRequest[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
    });
    req.on('end', () => {
      const headers = req.headers as Record<string, unknown>;
      requests.push({ body, headers });
      handler({ attempt: requests.length, body, headers, res });
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;

  const wrapper: MockServer = {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
  open.push(wrapper);
  return wrapper;
}

function sseDelta(res: ServerResponse, text: string): void {
  res.write(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`,
  );
}

function sseStop(res: ServerResponse): void {
  res.write(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
  );
  res.write('data: [DONE]\n\n');
  res.end();
}

function json500(res: ServerResponse): void {
  res.writeHead(500, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'upstream boom' } }));
}

const req = {
  messages: [{ role: 'system' as const, content: '你是守秘人' }],
  model: 'test-model',
  temperature: 0.7,
  maxTokens: 128,
  stream: true as const,
};

afterEach(async () => {
  await Promise.all(open.splice(0).map((server) => server.close()));
});

describe('openai-compat 适配器（T-M0-08）', () => {
  it('流式增量按序回调，最终 content 为拼接结果', async () => {
    const server = await startMockServer(({ res }) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      sseDelta(res, '你');
      sseDelta(res, '好');
      sseStop(res);
    });

    const deltas: string[] = [];
    const res = await createOpenAiCompatAdapter({ baseUrl: server.url, apiKey: 'sk-test' }).chat(
      req,
      (delta) => deltas.push(delta),
    );

    expect(deltas).toEqual(['你', '好']);
    expect(res.content).toBe('你好');
    expect(res.aborted).toBe(false);
    expect(res.finishReason).toBe('stop');
  });

  it('请求携带 Bearer 鉴权与模型名', async () => {
    const server = await startMockServer(({ res }) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      sseStop(res);
    });

    await createOpenAiCompatAdapter({ baseUrl: server.url, apiKey: 'sk-test-key' }).chat(
      req,
      () => undefined,
    );

    expect(server.requests[0]?.headers.authorization).toBe('Bearer sk-test-key');
    expect(server.requests[0]?.body).toContain('test-model');
  });

  it('5xx 指数退避重试 2 次后成功（E-LLM-01 前先自愈）', async () => {
    const server = await startMockServer(({ attempt, res }) => {
      if (attempt <= 2) {
        json500(res);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      sseDelta(res, '你');
      sseStop(res);
    });

    const res = await createOpenAiCompatAdapter({
      baseUrl: server.url,
      retryDelayMs: 0,
    }).chat(req, () => undefined);

    expect(res.content).toBe('你');
    expect(server.requests).toHaveLength(3);
  });

  it('连续 5xx 后以 E-LLM-01 失败，且只重试 2 次', async () => {
    const server = await startMockServer(({ res }) => json500(res));

    await expect(
      createOpenAiCompatAdapter({ baseUrl: server.url, retryDelayMs: 0 }).chat(
        req,
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: 'E-LLM-01' });
    expect(server.requests).toHaveLength(3);
  });

  it('超时同样按 E-LLM-01 处理', async () => {
    const server = await startMockServer(() => undefined); // 永不响应

    await expect(
      createOpenAiCompatAdapter({
        baseUrl: server.url,
        timeoutMs: 40,
        retryDelayMs: 0,
      }).chat(req, () => undefined),
    ).rejects.toMatchObject({ code: 'E-LLM-01' });
    expect(server.requests).toHaveLength(3);
  });

  it('流提前 FIN 关闭（未收到 [DONE]）：保留已收增量并标记中断（E-LLM-02）', async () => {
    const server = await startMockServer(({ res }) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      sseDelta(res, '你');
      sseDelta(res, '好');
      res.end(); // 正常 FIN，但既无 finish_reason 也无 [DONE]
    });

    const res = await createOpenAiCompatAdapter({ baseUrl: server.url }).chat(req, () => undefined);

    expect(res.content).toBe('你好');
    expect(res.aborted).toBe(true);
    expect(res.finishReason).toBe('aborted');
  });

  it('最后一个增量被截断时不崩溃：已收部分照常保留', async () => {
    const server = await startMockServer(({ res }) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      sseDelta(res, '你');
      res.write('data: {"choices":[{"index":0,"delta":{"content":"好"'); // 半行，未闭合
      res.end();
    });

    const res = await createOpenAiCompatAdapter({ baseUrl: server.url }).chat(req, () => undefined);

    expect(res.content).toBe('你');
    expect(res.aborted).toBe(true);
  });

  it('连接被硬切断（RST）时不抛出未捕获异常', async () => {
    const server = await startMockServer(({ res }) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      sseDelta(res, '你');
      sseDelta(res, '好');
      // 留足时间让数据 flush 到对端，避免同 tick destroy 把未 flush 数据一起丢弃
      setTimeout(() => res.destroy(), 50);
    });

    // 硬 RST 在传输层的表现取决于时机：可能已收增量并按中断返回，也可能底层 fetch 直接失败
    const outcome = await createOpenAiCompatAdapter({ baseUrl: server.url })
      .chat(req, () => undefined)
      .then(
        (res) => ({ resolved: true as const, res }),
        (err: unknown) => ({ resolved: false as const, err }),
      );

    if (outcome.resolved) {
      expect(outcome.res.aborted).toBe(true);
      expect('你好'.startsWith(outcome.res.content)).toBe(true);
    } else {
      expect(outcome.err).toMatchObject({ code: 'E-LLM-01' });
    }
  });

  it('标识符为 openai-compat', () => {
    expect(createOpenAiCompatAdapter({ baseUrl: 'http://127.0.0.1:1/v1' }).id).toBe(
      'openai-compat',
    );
  });
});

describe('ollama 适配器（T-M0-09）', () => {
  it('默认端点为本地 11434 的兼容地址', () => {
    expect(OLLAMA_DEFAULT_BASE_URL).toBe('http://localhost:11434/v1');
  });

  it('无 key：请求不带 Authorization（本地推理免鉴权）', async () => {
    process.env.AIDLE_LLM_KEY = 'sk-should-not-leak';
    const server = await startMockServer(({ res }) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      sseStop(res);
    });

    await createOllamaAdapter({ baseUrl: server.url, model: 'llama3' }).chat(req, () => undefined);

    expect(server.requests[0]?.headers.authorization).toBeUndefined();
    delete process.env.AIDLE_LLM_KEY;
  });

  it('SSE 解析与 openai-compat 一致', async () => {
    const server = await startMockServer(({ res }) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      sseDelta(res, '你');
      sseDelta(res, '好');
      sseStop(res);
    });

    const deltas: string[] = [];
    const res = await createOllamaAdapter({ baseUrl: server.url, model: 'llama3' }).chat(
      req,
      (delta) => deltas.push(delta),
    );

    expect(deltas).toEqual(['你', '好']);
    expect(res.content).toBe('你好');
  });

  it('标识符为 ollama', () => {
    expect(createOllamaAdapter().id).toBe('ollama');
  });
});

describe('TC-FR-03-001：双 provider 结构同构对拍', () => {
  it('openai-compat 与 MockLlm 对同一请求产出同构事件序列', async () => {
    const script = ['你', '好', '，守秘人'];
    const server = await startMockServer(({ res }) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const text of script) sseDelta(res, text);
      sseStop(res);
    });

    const viaHttp: string[] = [];
    const httpRes = await createOpenAiCompatAdapter({ baseUrl: server.url }).chat(req, (delta) =>
      viaHttp.push(delta),
    );

    const viaMock: string[] = [];
    const mockRes = await createMockLlm({
      script: script.map((delta) => ({ delta })),
    }).chat(req, (delta) => viaMock.push(delta));

    expect(viaHttp).toEqual(script);
    expect(viaMock).toEqual(viaHttp);
    expect(httpRes.content).toBe(mockRes.content);
    expect(httpRes.aborted).toBe(mockRes.aborted);
  });
});
