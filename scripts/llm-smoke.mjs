/**
 * LLM 真机冒烟（TC-FR-03-101/102 手测辅助工具）。
 *
 * provider 编辑点 = data/config.yaml 的 llm 段（key 只走环境变量 AIDLE_LLM_KEY，永不落盘）：
 *   llm:
 *     provider: openai-compat
 *     baseUrl: https://token.sensenova.cn/v1
 *     model: sensenova-6.8-flash-lite
 *     timeoutMs: 60000
 *
 * 用法：
 *   AIDLE_LLM_KEY=sk-xxx node scripts/llm-smoke.mjs \
 *     [--provider p] [--base-url u] [--model m] [--timeout-ms n] [--max-tokens n] [--prompt 文本]
 * 校验口径（与手测清单一致）：增量按序到达、finishReason=stop、无 aborted。
 */
import { resolve } from 'node:path';

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

let loadConfig;
let createLlmAdapter;
try {
  ({ loadConfig } = await import('../packages/server/dist/config.js'));
  ({ createLlmAdapter } = await import('../packages/server/dist/adapters/llm/index.js'));
} catch {
  console.error('[llm-smoke] 无法加载构建产物，请先执行 pnpm build');
  process.exit(1);
}

const cfg = loadConfig({ dataDir: resolve('data') });
const provider = argValue('--provider') ?? cfg.llm.provider;
const baseUrl = argValue('--base-url') ?? cfg.llm.baseUrl;
const model = argValue('--model') ?? cfg.llm.model;
const timeoutMs = Number(argValue('--timeout-ms') ?? cfg.llm.timeoutMs ?? 60_000);
const maxTokens = Number(argValue('--max-tokens') ?? cfg.llm.maxTokens ?? 1024);
const prompt = argValue('--prompt') ?? '用两三句话介绍文字跑团中 KP（守秘人）的职责。';

console.log(
  `[llm-smoke] provider=${provider} model=${model ?? '(未设置)'} baseUrl=${baseUrl ?? '(未设置)'}`,
);

if (!baseUrl) {
  console.error(
    '[llm-smoke] 缺少 baseUrl：请在 data/config.yaml 的 llm 段设置，或用 --base-url 传入',
  );
  process.exit(1);
}
if (!model) {
  console.error('[llm-smoke] 缺少 model：请在 data/config.yaml 或 --model 传入');
  process.exit(1);
}
if (!process.env['AIDLE_LLM_KEY'] && provider !== 'ollama') {
  console.warn('[llm-smoke] 未设置 AIDLE_LLM_KEY：云端 provider 大概率返回 401');
}

const adapter = createLlmAdapter({
  provider,
  model,
  baseUrl,
  timeoutMs,
  apiKey: process.env['AIDLE_LLM_KEY'],
});

const deltas = [];
console.log('[llm-smoke] 开始流式请求……');
const startedAt = Date.now();
let firstDeltaAt = null;
let res;
try {
  res = await adapter.chat(
    {
      messages: [{ role: 'user', content: prompt }],
      model,
      temperature: 0.7,
      maxTokens,
      stream: true,
    },
    (delta) => {
      if (firstDeltaAt === null) firstDeltaAt = Date.now();
      deltas.push(delta);
      process.stdout.write(delta);
    },
  );
} catch (err) {
  console.error('\n[llm-smoke] 请求失败：', err?.code ?? '', err?.message ?? err);
  process.exit(1);
}
const elapsed = Date.now() - startedAt;

console.log('\n[llm-smoke] ---- 结构校验 ----');
console.log(
  JSON.stringify(
    {
      deltas: deltas.length,
      contentChars: res.content.length,
      finishReason: res.finishReason,
      aborted: res.aborted,
      usage: res.usage ?? null,
      firstDeltaMs: firstDeltaAt === null ? null : firstDeltaAt - startedAt,
      totalMs: elapsed,
    },
    null,
    2,
  ),
);

const ok = deltas.length > 0 && res.finishReason === 'stop' && res.aborted === false;
console.log(ok ? '[llm-smoke] 通过：增量按序到达且正常终止' : '[llm-smoke] 未通过：结构不符合预期');
process.exit(ok ? 0 : 1);
