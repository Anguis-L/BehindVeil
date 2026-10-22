<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useSessionStore } from '../stores/session';
import type { LlmConfigPatch } from '../stores/session';

/**
 * AI 模型设置（2026-10-08 可用性改造）。
 *
 * 此前换模型只有一条路：手改 data/config.yaml + 设环境变量 AIDLE_LLM_KEY，再重启服务。
 * 非技术用户等于「不会换」。本面板把它变成页面上三步：选服务商 → 填密钥 → 测试连接 → 保存。
 *
 * 口径：密钥只进服务端内存，**永不落盘、永不回显**（NFR-03）——输入框永远是空的，
 * 已填了只显示打码提示（apiKeyHint）；改完下一次 AI 调用即生效，不用重启。
 */

const emit = defineEmits<{ (e: 'close'): void }>();
const store = useSessionStore();

/** 服务商预设：填地址与示例模型，用户可改（兼容 OpenAI 接口的都能用） */
interface Preset {
  key: string;
  label: string;
  provider: string;
  baseUrl: string;
  model: string;
  /** 本机 Ollama 之类不需要密钥 */
  needKey: boolean;
  hint: string;
}

const PRESETS: Preset[] = [
  {
    key: 'deepseek',
    label: 'DeepSeek（深度求索）',
    provider: 'openai-compat',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    needKey: true,
    hint: '便宜、中文叙事稳，新手首选',
  },
  {
    key: 'glm',
    label: '智谱 GLM',
    provider: 'openai-compat',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    needKey: true,
    hint: '有免费额度，可先试跑',
  },
  {
    key: 'moonshot',
    label: '月之暗面 Kimi',
    provider: 'openai-compat',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    needKey: true,
    hint: '长上下文好，适合长团',
  },
  {
    key: 'qwen',
    label: '阿里通义千问',
    provider: 'openai-compat',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    needKey: true,
    hint: '国内直连稳',
  },
  {
    key: 'siliconflow',
    label: '硅基流动 SiliconFlow',
    provider: 'openai-compat',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-7B-Instruct',
    needKey: true,
    hint: '聚合多家开源模型',
  },
  {
    key: 'sensenova',
    label: '商汤 SenseNova',
    provider: 'openai-compat',
    baseUrl: 'https://token.sensenova.cn/v1',
    model: 'sensenova-6.8-flash-lite',
    needKey: true,
    hint: '本项目默认配置的服务商',
  },
  {
    key: 'openai',
    label: 'OpenAI',
    provider: 'openai-compat',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    needKey: true,
    hint: '需要能访问境外网络',
  },
  {
    key: 'ollama',
    label: 'Ollama（本机模型）',
    provider: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:7b',
    needKey: false,
    hint: '完全离线、不花钱，但要自己先装好模型',
  },
  {
    key: 'custom',
    label: '自定义 / 其他兼容接口',
    provider: 'openai-compat',
    baseUrl: '',
    model: '',
    needKey: true,
    hint: '任何兼容 OpenAI 接口的地址都行',
  },
];

const presetKey = ref('custom');
const baseUrl = ref('');
const model = ref('');
const apiKey = ref('');
const timeoutMs = ref(60_000);
const maxTokens = ref(2048);
const showAdvanced = ref(false);

const notice = ref('');
const testResult = ref<{ ok: boolean; text: string } | null>(null);

const current = computed(() => store.llm);
const ready = computed(() => current.value?.ready === true);

/** 与当前配置对得上的预设（猜不出来就落 custom，不猜错） */
function detectPreset(): void {
  const snap = current.value;
  if (!snap) return;
  const hit = PRESETS.find((p) => p.baseUrl !== '' && snap.baseUrl.startsWith(p.baseUrl));
  presetKey.value = hit ? hit.key : 'custom';
  baseUrl.value = snap.baseUrl;
  model.value = snap.model;
  timeoutMs.value = snap.timeoutMs;
  maxTokens.value = snap.maxTokens;
  apiKey.value = ''; // 密钥永不回显（NFR-03）
}

onMounted(async () => {
  await store.loadLlmConfig();
  detectPreset();
});

function applyPreset(): void {
  const preset = PRESETS.find((p) => p.key === presetKey.value);
  if (!preset || preset.key === 'custom') return;
  baseUrl.value = preset.baseUrl;
  if (model.value === '' || PRESETS.some((p) => p.model === model.value)) {
    model.value = preset.model;
  }
  testResult.value = null;
}

/** 收集本次要提交的配置：密钥为空表示「不改动已填的」，不算清除 */
function collectPatch(includeEmptyKey: boolean): LlmConfigPatch {
  const preset = PRESETS.find((p) => p.key === presetKey.value);
  const patch: LlmConfigPatch = {
    provider: preset?.provider ?? 'openai-compat',
    model: model.value.trim(),
    baseUrl: baseUrl.value.trim(),
    timeoutMs: timeoutMs.value,
    maxTokens: maxTokens.value,
  };
  if (apiKey.value !== '') patch.apiKey = apiKey.value.trim();
  else if (includeEmptyKey) delete patch.apiKey;
  return patch;
}

async function testConnection(): Promise<void> {
  notice.value = '';
  testResult.value = null;
  const res = await store.testLlmConnection(collectPatch(false));
  testResult.value = {
    ok: res.ok,
    text: res.ok
      ? `连上了（${res.latencyMs} ms）· 模型 ${res.model || model.value}`
      : `连不上：${res.message ?? '未知原因'}`,
  };
}

async function save(): Promise<void> {
  notice.value = '';
  const ok = await store.saveLlmConfig(collectPatch(false));
  if (!ok) {
    notice.value = store.error;
    return;
  }
  apiKey.value = ''; // 保存后立刻清空输入框（页面不留密钥）
  notice.value = ready.value
    ? '已保存并生效，下一次 AI 回应就用新模型'
    : `已保存，但还没就绪：${current.value?.error ?? ''}`;
}
</script>

<template>
  <div class="bv-llm" role="dialog" aria-label="AI 模型设置">
    <div class="bv-llm__panel">
      <header class="bv-llm__head">
        <h2>AI 模型设置</h2>
        <button class="bv-llm__close" type="button" @click="emit('close')">关闭</button>
      </header>

      <p class="bv-llm__lead">
        KP 的脑子接在哪儿，由这里决定。选一个服务商、填密钥，点「测试连接」通过即可——
        <strong>不用重启服务</strong>。
      </p>

      <div class="bv-llm__status" :class="ready ? 'bv-llm__status--ok' : 'bv-llm__status--bad'">
        <template v-if="current">
          <span>{{ ready ? '● 已就绪' : '● 未就绪' }}</span>
          <span class="bv-llm__status-detail">
            <template v-if="ready">
              {{ current.baseUrl || '默认端点' }} · {{ current.model }}
              <template v-if="current.hasApiKey">· 密钥 {{ current.apiKeyHint }}</template>
              <template v-else>· 未填密钥</template>
            </template>
            <template v-else>{{ current.error || '还没配置模型' }}</template>
          </span>
        </template>
        <template v-else>读取中…</template>
      </div>

      <label class="bv-llm__field">
        <span>服务商</span>
        <select v-model="presetKey" class="bv-llm__input" @change="applyPreset">
          <option v-for="p in PRESETS" :key="p.key" :value="p.key">{{ p.label }}</option>
        </select>
      </label>
      <p class="bv-llm__hint">{{ PRESETS.find((p) => p.key === presetKey)?.hint }}</p>

      <label class="bv-llm__field">
        <span>接口地址</span>
        <input v-model="baseUrl" class="bv-llm__input" placeholder="https://api.deepseek.com/v1" />
      </label>

      <label class="bv-llm__field">
        <span>模型名</span>
        <input v-model="model" class="bv-llm__input" placeholder="deepseek-chat" />
      </label>

      <label class="bv-llm__field">
        <span>
          密钥（API Key）
          <em class="bv-llm__note">只存在服务内存里，不会写进文件，也不会回显</em>
        </span>
        <input
          v-model="apiKey"
          class="bv-llm__input"
          type="password"
          autocomplete="off"
          :placeholder="current?.hasApiKey ? `已填 ${current.apiKeyHint}，留空表示不改` : 'sk-…'"
        />
      </label>

      <details class="bv-llm__advanced">
        <summary>高级（超时 / 输出长度）</summary>
        <label class="bv-llm__field">
          <span>超时（毫秒）</span>
          <input v-model.number="timeoutMs" class="bv-llm__input" type="number" min="1000" />
        </label>
        <label class="bv-llm__field">
          <span>单次最大输出 tokens</span>
          <input v-model.number="maxTokens" class="bv-llm__input" type="number" min="256" />
        </label>
      </details>

      <div class="bv-llm__actions">
        <button
          class="bv-llm__btn"
          type="button"
          :disabled="store.llmTesting"
          @click="testConnection"
        >
          {{ store.llmTesting ? '测试中…' : '测试连接' }}
        </button>
        <button class="bv-llm__btn bv-llm__btn--primary" type="button" @click="save">
          保存并启用
        </button>
      </div>

      <p v-if="testResult" class="bv-llm__result" :class="testResult.ok ? 'is-ok' : 'is-bad'">
        {{ testResult.text }}
      </p>
      <p v-if="notice" class="bv-llm__result">{{ notice }}</p>
      <p v-if="store.error && !notice" class="bv-llm__result is-bad">{{ store.error }}</p>

      <p class="bv-llm__foot">
        提示：密钥只活在当前服务进程里，重启后会回到配置文件/环境变量的设置。
        想长期固定，就让部署的人把 <code>AIDLE_LLM_KEY</code> 配好。
      </p>
    </div>
  </div>
</template>

<style scoped>
.bv-llm {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: grid;
  place-items: center;
  padding: var(--bv-space-4);
  background: rgb(0 0 0 / 62%);
}
.bv-llm__panel {
  width: min(520px, 100%);
  max-height: calc(100vh - 32px);
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: var(--bv-space-3);
  padding: var(--bv-space-6);
  border: 1px solid var(--bv-line-subtle);
  border-radius: var(--bv-radius-card);
  background: var(--bv-bg-surface);
  color: var(--bv-text-primary);
}
.bv-llm__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.bv-llm__head h2 {
  margin: 0;
  font-size: 18px;
  letter-spacing: 0.04em;
}
.bv-llm__close {
  border: 1px solid var(--bv-line-subtle);
  border-radius: var(--bv-radius-card);
  background: transparent;
  color: var(--bv-text-secondary);
  font: inherit;
  font-size: 12px;
  padding: 4px 10px;
  cursor: pointer;
}
.bv-llm__lead {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--bv-text-secondary);
}
.bv-llm__status {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--bv-space-3);
  border-radius: var(--bv-radius-card);
  font-size: 12px;
  background: var(--bv-bg-elevated);
}
.bv-llm__status--ok {
  color: var(--bv-judge-extreme);
}
.bv-llm__status--bad {
  color: var(--bv-judge-fail);
}
.bv-llm__status-detail {
  color: var(--bv-text-secondary);
  word-break: break-all;
}
.bv-llm__field {
  display: flex;
  flex-direction: column;
  gap: var(--bv-space-2);
  font-size: 13px;
  color: var(--bv-text-secondary);
}
.bv-llm__note {
  font-style: normal;
  font-size: 11px;
  color: var(--bv-text-tertiary);
}
.bv-llm__input {
  padding: var(--bv-space-3);
  border: 1px solid var(--bv-line-subtle);
  border-radius: var(--bv-radius-card);
  background: var(--bv-bg-elevated);
  color: var(--bv-text-primary);
  font: inherit;
}
.bv-llm__hint {
  margin: -4px 0 0;
  font-size: 12px;
  color: var(--bv-text-tertiary);
}
.bv-llm__advanced summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--bv-text-tertiary);
}
.bv-llm__advanced .bv-llm__field {
  margin-top: var(--bv-space-3);
}
.bv-llm__actions {
  display: flex;
  gap: var(--bv-space-3);
}
.bv-llm__btn {
  flex: 1;
  padding: var(--bv-space-3);
  border: 1px solid var(--bv-line-subtle);
  border-radius: var(--bv-radius-card);
  background: var(--bv-bg-elevated);
  color: var(--bv-text-primary);
  font: inherit;
  cursor: pointer;
}
.bv-llm__btn--primary {
  border: none;
  background: var(--bv-accent);
  color: var(--bv-bg-canvas);
  font-weight: 600;
}
.bv-llm__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.bv-llm__result {
  margin: 0;
  font-size: 12px;
  color: var(--bv-text-secondary);
}
.bv-llm__result.is-ok {
  color: var(--bv-judge-extreme);
}
.bv-llm__result.is-bad {
  color: var(--bv-judge-fail);
}
.bv-llm__foot {
  margin: 0;
  font-size: 11px;
  line-height: 1.7;
  color: var(--bv-text-tertiary);
}
</style>
