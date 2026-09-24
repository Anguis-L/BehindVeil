import { describe, expect, it } from 'vitest';
import { createMockLlm } from './mock.js';

/**
 * T-M0-10：MockLlm（脚本化回放适配器，TDD §10）。
 * 黄金用例与 E2E 全部依赖它在无 key 环境下运行；M3 的 50 轮回归用它注入格式错误。
 */

const req = {
  messages: [{ role: 'system' as const, content: '你是守秘人' }],
  model: 'mock-model',
  temperature: 0.7,
  maxTokens: 128,
  stream: true as const,
};

const collect = async (adapter: ReturnType<typeof createMockLlm>): Promise<string[]> => {
  const deltas: string[] = [];
  await adapter.chat(req, (delta) => deltas.push(delta));
  return deltas;
};

describe('MockLlm 脚本化回放', () => {
  it('按脚本顺序回放 delta', async () => {
    const adapter = createMockLlm({
      script: [{ delta: '你' }, { delta: '好' }, { delta: '，守秘人' }],
    });

    expect(await collect(adapter)).toEqual(['你', '好', '，守秘人']);
  });

  it('最终 content 为增量拼接结果', async () => {
    const adapter = createMockLlm({ script: [{ delta: '你' }, { delta: '好' }] });

    const res = await adapter.chat(req, () => undefined);

    expect(res.content).toBe('你好');
    expect(res.aborted).toBe(false);
  });

  it('空脚本产出空 content', async () => {
    const adapter = createMockLlm({ script: [] });

    const res = await adapter.chat(req, () => undefined);

    expect(res.content).toBe('');
  });

  it('标识符为 mock（日志与 /metrics 可区分）', () => {
    expect(createMockLlm().id).toBe('mock');
  });
});

describe('MockLlm 指令块注入（FR-05 回归用）', () => {
  it('directive 步骤产出 aidle 栅栏块', async () => {
    const adapter = createMockLlm({
      script: [
        { delta: '你翻查书桌。' },
        { directive: { op: 'check', target: 'pc:alice', skill: '侦查', difficulty: 'normal' } },
      ],
    });

    const res = await adapter.chat(req, () => undefined);

    expect(res.content).toContain('```aidle');
    expect(res.content).toContain('"skill": "侦查"');
  });

  it('errorRate=1 时产出畸形指令块（降级链与 R-01 指标用）', async () => {
    const adapter = createMockLlm({
      script: [{ directive: { op: 'check', skill: '侦查' } }],
      errorRate: 1,
    });

    const res = await adapter.chat(req, () => undefined);
    const block = res.content.slice(res.content.indexOf('```aidle'));

    expect(block).toContain('```aidle');
    expect(() => JSON.parse(block.replace(/```aidle|```/g, '').trim())).toThrow();
  });
});

describe('MockLlm 错误注入与调用留痕', () => {
  it('error 步骤以业务错误码拒绝', async () => {
    const adapter = createMockLlm({
      script: [{ delta: '一半' }, { error: 'E-LLM-01' }],
    });

    await expect(adapter.chat(req, () => undefined)).rejects.toMatchObject({ code: 'E-LLM-01' });
  });

  it('记录每次调用的请求（契约对拍与回归分析用）', async () => {
    const adapter = createMockLlm({ script: [{ delta: 'x' }] });

    await adapter.chat(req, () => undefined);

    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]).toMatchObject({ model: 'mock-model' });
  });
});
