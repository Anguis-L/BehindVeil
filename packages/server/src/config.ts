import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * 配置装载（T-M0-05，TDD §6/§7、NFR-03）。
 *
 * 铁律：config.yaml（data/config.yaml）只放非敏感项；LLM key 只从环境变量
 * AIDLE_LLM_KEY 读取。配置文件中出现密钥类字段（apiKey/token/secret/…）直接
 * 拒绝装载——key 永不落盘。装载为同步操作（启动路径一次性调用）。
 */

/** 与 NFR-03 语义一致的敏感字段模式（大小写不敏感，深扫全部层级） */
const SENSITIVE_KEY_RE = /(api[-_]?key|apikey|token|secret|password|authorization)/i;

const ConfigFileSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(0).max(65535).default(8787),
  llm: z
    .object({
      /** 'openai-compat' | 'ollama'（TDD §7）；其余 provider 二期 */
      provider: z.string().default('openai-compat'),
      model: z.string().default(''),
      /** 兼容端点根；缺省时由适配器决定（ollama 有默认端点） */
      baseUrl: z.string().optional(),
      timeoutMs: z.number().int().positive().default(60_000),
      maxTokens: z.number().int().positive().default(2048),
    })
    .prefault({}),
});

export interface LlmConfig {
  provider: string;
  model: string;
  baseUrl: string | undefined;
  timeoutMs: number;
  maxTokens: number;
  /** 仅来自环境变量 AIDLE_LLM_KEY；未设置时为 undefined */
  apiKey: string | undefined;
}

export interface AppConfig {
  dataDir: string;
  host: string;
  port: number;
  llm: LlmConfig;
  /**
   * 管理面门禁（决议 ②）：设置 AIDLE_ADMIN_TOKEN 后，除 /healthz 外的管理接口
   * 必须携带 X-Admin-Token 头；未设置则不启用（零配置，依托网络边界）。
   */
  adminToken: string | undefined;
}

export function loadConfig(opts: {
  dataDir: string;
  env?: Record<string, string | undefined>;
}): AppConfig {
  const configFile = join(opts.dataDir, 'config.yaml');
  const raw = readConfigFile(configFile);
  const parsed = ConfigFileSchema.parse(raw);
  const env = opts.env ?? process.env;
  return {
    dataDir: opts.dataDir,
    host: parsed.host,
    port: parsed.port,
    llm: {
      provider: parsed.llm.provider,
      model: parsed.llm.model,
      baseUrl: parsed.llm.baseUrl,
      timeoutMs: parsed.llm.timeoutMs,
      maxTokens: parsed.llm.maxTokens,
      apiKey: env['AIDLE_LLM_KEY'],
    },
    adminToken: env['AIDLE_ADMIN_TOKEN'],
  };
}

function readConfigFile(configFile: string): unknown {
  let text: string | undefined;
  try {
    text = readFileSync(configFile, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}; // 尚无配置文件 → 全默认
    throw new Error(`config.yaml 读取失败：${err instanceof Error ? err.message : String(err)}`);
  }

  let parsedYaml: unknown;
  try {
    parsedYaml = parseYaml(text);
  } catch (err) {
    throw new Error(`config.yaml 解析失败：${err instanceof Error ? err.message : String(err)}`);
  }
  assertNoSensitiveFields(parsedYaml, configFile);
  return parsedYaml;
}

function assertNoSensitiveFields(value: unknown, source: string): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoSensitiveFields(item, source);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY_RE.test(key)) {
      throw new Error(
        `${source} 含敏感字段 "${key}"：密钥只能来自环境变量 AIDLE_LLM_KEY（NFR-03，key 永不落盘）`,
      );
    }
    assertNoSensitiveFields(child, source);
  }
}
