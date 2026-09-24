import { afterEach, describe, expect, it } from 'vitest';
import { redact } from './redact.js';

/**
 * T-M0-05：redact()（NFR-03 / TDD §7）。
 * 覆盖 TC-NFR-03-001：日志 / 错误 / 预览 / 导出全链路过滤密钥。
 * 多形态覆盖：header、body、query、错误堆栈、环境变量默认值。
 */

const SECRET = 'sk-live-abcdef123456';

afterEach(() => {
  delete process.env.AIDLE_LLM_KEY;
});

const contains = (value: unknown, needle: string): boolean =>
  JSON.stringify(value).includes(needle);

describe('redact 显式密钥', () => {
  it('过滤 Authorization 请求头', () => {
    const req = { headers: { authorization: `Bearer ${SECRET}` } };

    const out = redact(req, [SECRET]);

    expect(contains(out, SECRET)).toBe(false);
    expect(out).toMatchObject({ headers: { authorization: expect.stringContaining('***') } });
  });

  it('过滤请求体中的 api_key 字段', () => {
    const req = { body: { model: 'deepseek-chat', api_key: SECRET } };

    const out = redact(req, [SECRET]);

    expect(contains(out, SECRET)).toBe(false);
    expect(out).toMatchObject({ body: { model: 'deepseek-chat' } });
  });

  it('过滤 query string 中的密钥', () => {
    const req = { url: `https://api.example.com/v1/chat?key=${SECRET}&model=m` };

    const out = redact(req, [SECRET]);

    expect(contains(out, SECRET)).toBe(false);
  });

  it('过滤错误堆栈中的密钥', () => {
    const err = new Error(`request failed with key ${SECRET}`);

    const out = redact({ stack: err.stack ?? '' }, [SECRET]);

    expect(contains(out, SECRET)).toBe(false);
  });

  it('深层嵌套与数组同样过滤', () => {
    const payload = { a: { b: [{ c: `x${SECRET}y` }] }, list: [SECRET] };

    const out = redact(payload, [SECRET]);

    expect(contains(out, SECRET)).toBe(false);
  });

  it('不修改入参对象（日志脱敏不应有副作用）', () => {
    const req = { headers: { authorization: `Bearer ${SECRET}` } };

    redact(req, [SECRET]);

    expect(req.headers.authorization).toBe(`Bearer ${SECRET}`);
  });

  it('非敏感内容原样保留', () => {
    const payload = { content: '你好，守秘人', seq: 3 };

    expect(redact(payload, [SECRET])).toEqual(payload);
  });
});

describe('redact 默认密钥来源', () => {
  it('未显式传密钥时，从 AIDLE_LLM_KEY 收集', () => {
    process.env.AIDLE_LLM_KEY = SECRET;

    const out = redact({ headers: { authorization: `Bearer ${SECRET}` } });

    expect(contains(out, SECRET)).toBe(false);
  });

  it('同时支持显式密钥与环境变量密钥', () => {
    process.env.AIDLE_LLM_KEY = 'sk-env-111';
    const out = redact({ a: 'sk-env-111', b: 'sk-explicit-222' }, ['sk-explicit-222']);

    expect(contains(out, 'sk-env-111')).toBe(false);
    expect(contains(out, 'sk-explicit-222')).toBe(false);
  });
});
