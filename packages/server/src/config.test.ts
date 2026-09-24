import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

/**
 * T-M0-05：配置与密钥（TDD §6 / §7，NFR-03）。
 * 铁律：config.yaml 只放非敏感项；API key 只从环境变量 AIDLE_LLM_KEY 来。
 */

const created: string[] = [];

async function makeDataDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'bv-config-'));
  created.push(dir);
  return dir;
}

const yaml = [
  'port: 4177',
  'host: 127.0.0.1',
  'llm:',
  '  provider: openai-compat',
  '  baseUrl: https://api.deepseek.com/v1',
  '  model: deepseek-chat',
  '  timeoutMs: 30000',
].join('\n');

afterAll(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('loadConfig 非敏感项装载', () => {
  it('从 config.yaml 读取端口与模型配置', async () => {
    const dataDir = await makeDataDir();
    await writeFile(path.join(dataDir, 'config.yaml'), yaml, 'utf8');

    const cfg = loadConfig({ dataDir, env: {} });

    expect(cfg.dataDir).toBe(dataDir);
    expect(cfg.port).toBe(4177);
    expect(cfg.llm.provider).toBe('openai-compat');
    expect(cfg.llm.model).toBe('deepseek-chat');
    expect(cfg.llm.baseUrl).toBe('https://api.deepseek.com/v1');
  });

  it('config.yaml 不存在时回落到默认配置', async () => {
    const dataDir = await makeDataDir();

    const cfg = loadConfig({ dataDir, env: {} });

    expect(cfg.dataDir).toBe(dataDir);
    expect(typeof cfg.port).toBe('number');
    expect(['openai-compat', 'ollama']).toContain(cfg.llm.provider);
  });
});

describe('loadConfig 密钥只来自环境变量（NFR-03）', () => {
  it('AIDLE_LLM_KEY 注入 apiKey', async () => {
    const dataDir = await makeDataDir();
    await writeFile(path.join(dataDir, 'config.yaml'), yaml, 'utf8');

    const cfg = loadConfig({ dataDir, env: { AIDLE_LLM_KEY: 'sk-from-env-000' } });

    expect(cfg.llm.apiKey).toBe('sk-from-env-000');
  });

  it('未设置环境变量时 apiKey 为空', async () => {
    const dataDir = await makeDataDir();
    await writeFile(path.join(dataDir, 'config.yaml'), yaml, 'utf8');

    const cfg = loadConfig({ dataDir, env: {} });

    expect(cfg.llm.apiKey).toBeUndefined();
  });

  it('config.yaml 中出现密钥字段即拒绝装载（key 永不落文件）', async () => {
    const dataDir = await makeDataDir();
    await writeFile(
      path.join(dataDir, 'config.yaml'),
      `${yaml}\n  apiKey: sk-in-file-999\n`,
      'utf8',
    );

    expect(() => loadConfig({ dataDir, env: {} })).toThrow(/apiKey|密钥|敏感/);
  });

  it('config.yaml 中的 token/secret 类字段同样被拒绝', async () => {
    const dataDir = await makeDataDir();
    for (const field of ['token', 'secret', 'authorization']) {
      await writeFile(path.join(dataDir, 'config.yaml'), `${yaml}\n  ${field}: leak-me\n`, 'utf8');
      expect(() => loadConfig({ dataDir, env: {} }), `${field} 应被视为敏感字段`).toThrow();
    }
  });
});
