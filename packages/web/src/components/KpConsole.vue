<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useSessionStore } from '../stores/session';
import {
  formatCostCny,
  formatHitKeywords,
  formatIsoShort,
  formatLatency,
  formatPercent,
  formatTokenCount,
  parseSettingsDraft,
  sessionStateLabel,
  summarizeTrace,
  type SettingsDraft,
} from '../kp-console.js';

/**
 * KP 控制台（T-M6-04/05，FR-13 / R-02）：房间页右栏的第三个标签，不是独立页面——
 * KP 不离开消息流就能核对 prompt 组装、调参数、管会话、看开销。
 *
 * 分工：房内数据一律走 Socket（前端不带 X-Admin-Token），只有管理性质的
 * 会话管理 / 参数设置走 REST，令牌由 KP 自己填一次（见 admin-token.ts）。
 */

const store = useSessionStore();

const moduleId = ref('');
const tokenDraft = ref(store.adminToken);

// ---- Host 转让 / 副 Host（T-M8-06，FR-26）----
const hostTokenDraft = ref('');
const transferTarget = ref('');
const coHostTarget = ref('');
const hostNotice = ref('');
const hostError = ref('');

/** 可接任/可授副 Host 的成员：玩家且非本人（观察者与 Host 不参与，服务端同样校验） */
const transferableMembers = computed(() =>
  store.members.filter((m) => m.role === 'player' && m.id !== store.memberId),
);

async function hostApi(path: string, method: 'POST' | 'PUT', body: unknown): Promise<void> {
  const res = await fetch(`/rooms/${store.roomId}/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      typeof payload === 'object' &&
      payload !== null &&
      typeof (payload as { message?: unknown }).message === 'string'
        ? (payload as { message: string }).message
        : `请求失败（${res.status}）`;
    throw new Error(message);
  }
}

async function doTransfer(): Promise<void> {
  if (!transferTarget.value || !hostTokenDraft.value) return;
  hostError.value = '';
  try {
    await hostApi('host-transfer', 'POST', {
      hostToken: hostTokenDraft.value,
      toMemberId: transferTarget.value,
    });
    const name =
      store.members.find((m) => m.id === transferTarget.value)?.name ?? transferTarget.value;
    hostNotice.value = `已转让给 ${name}——你的 hostToken 已失效，本页现为玩家身份。`;
    hostTokenDraft.value = '';
    transferTarget.value = '';
    store.role = 'player'; // 服务端已降级本连接 presence，前端同步
  } catch (error) {
    hostError.value = error instanceof Error ? error.message : '转让失败';
  }
}

async function doSetCoHost(memberId: string | null): Promise<void> {
  hostError.value = '';
  try {
    await hostApi('co-host', 'PUT', { hostToken: hostTokenDraft.value, memberId });
    hostNotice.value = memberId === null ? '副 Host 已撤销' : '副 Host 已设置';
  } catch (error) {
    hostError.value = error instanceof Error ? error.message : '操作失败';
  }
}

const activeSession = computed(
  () => store.sessions.find((session) => session.id === store.activeSessionId) ?? null,
);
const currentSettings = computed(() => activeSession.value?.settings ?? null);

const draft = ref<SettingsDraft>({
  temperature: '',
  maxHistoryMessages: '',
  worldBookBudgetTokens: '',
  nat20Rule: 'attack_only',
});
// 读到会话设置即回填表单；KP 手改后只有与当前值不同的字段会进 patch
watch(
  currentSettings,
  (settings) => {
    if (!settings) return;
    draft.value = {
      temperature: String(settings.temperature),
      maxHistoryMessages: String(settings.maxHistoryMessages),
      worldBookBudgetTokens: String(settings.worldBookBudgetTokens),
      nat20Rule: settings.nat20Rule ?? 'attack_only',
    };
  },
  { immediate: true },
);

const parsed = computed(() => parseSettingsDraft(draft.value, currentSettings.value));
const canSaveSettings = computed(
  () => parsed.value.ok && Object.keys(parsed.value.patch).length > 0 && !!store.activeSessionId,
);

const summary = computed(() => (store.preview ? summarizeTrace(store.preview) : null));
const tokenTotal = computed(() => {
  const metrics = store.metrics;
  return metrics === null ? null : metrics.llm.tokensIn + metrics.llm.tokensOut;
});

function saveToken(): void {
  store.setAdminToken(tokenDraft.value);
}

function startSession(): void {
  const id = moduleId.value.trim();
  if (!id) return;
  store.startSession(id);
  moduleId.value = '';
}

async function saveSettings(): Promise<void> {
  if (!store.activeSessionId) return;
  await store.saveSessionSettings(store.activeSessionId, parsed.value.patch);
}

/** 刷新列表后表单会跟着回填，省掉「保存后还要手动刷」的一步 */
async function refreshSessions(): Promise<void> {
  await store.loadSessions();
}
</script>

<template>
  <div class="bv-kp">
    <p v-if="store.role !== 'host'" class="bv-kp__hint">KP 控制台仅 Host 可见。</p>

    <template v-else>
      <!-- 管理令牌：REST 侧会话管理的入口 -->
      <section class="bv-kp__block">
        <h3 class="bv-kp__title">管理令牌</h3>
        <p class="bv-kp__hint">
          会话列表 / 结束 / 切换 / 参数保存走管理面 REST，需要
          X-Admin-Token。令牌只存会话级存储，关标签页即失效。
        </p>
        <div class="bv-kp__row">
          <input
            v-model="tokenDraft"
            class="bv-kp__input"
            type="password"
            placeholder="X-Admin-Token"
            autocomplete="off"
            @keydown.enter="saveToken"
          />
          <button class="bv-kp__btn" type="button" @click="saveToken">
            {{ store.adminToken ? '更新' : '填入' }}
          </button>
        </div>
        <p class="bv-kp__hint">
          {{ store.adminToken ? '令牌已填入，会话管理可用' : '未填令牌，会话管理不可用' }}
        </p>
      </section>

      <!-- Host 转让 / 副 Host（T-M8-06，FR-26）：hostToken 授权的一次性管理操作 -->
      <section class="bv-kp__block">
        <h3 class="bv-kp__title">Host 转让 / 副 Host</h3>
        <label class="bv-kp__field">
          <span>hostToken（建房时下发，授权用）</span>
          <input
            v-model="hostTokenDraft"
            class="bv-kp__input bv-kp__mono"
            type="password"
            autocomplete="off"
          />
        </label>
        <div class="bv-kp__row">
          <select v-model="transferTarget" class="bv-kp__input">
            <option value="" disabled>选择接任成员（在线）</option>
            <option v-for="m in transferableMembers" :key="m.id" :value="m.id">{{ m.name }}</option>
          </select>
          <button
            class="bv-kp__btn"
            type="button"
            :disabled="!transferTarget || !hostTokenDraft"
            @click="doTransfer"
          >
            转让 Host
          </button>
        </div>
        <p class="bv-kp__hint">
          转让后你的 hostToken 立即轮换失效；对方凭成员身份重连即恢复 Host（本页同步变回玩家）。
        </p>
        <div class="bv-kp__row">
          <select v-model="coHostTarget" class="bv-kp__input">
            <option value="" disabled>选择副 Host（在线）</option>
            <option v-for="m in transferableMembers" :key="m.id" :value="m.id">{{ m.name }}</option>
          </select>
          <button
            class="bv-kp__btn bv-kp__btn--ghost"
            type="button"
            :disabled="!coHostTarget || !hostTokenDraft"
            @click="doSetCoHost(coHostTarget)"
          >
            设为副 Host
          </button>
          <button
            class="bv-kp__btn bv-kp__btn--ghost"
            type="button"
            :disabled="!hostTokenDraft"
            @click="doSetCoHost(null)"
          >
            撤销副 Host
          </button>
        </div>
        <p class="bv-kp__hint">
          副 Host 与 Host 同享快照与状态编辑权限（掉线代行），不发新 token。
        </p>
        <p v-if="hostNotice" class="bv-kp__hint">{{ hostNotice }}</p>
        <p v-if="hostError" class="bv-kp__err">{{ hostError }}</p>
      </section>

      <!-- 会话管理：开团 / 结束 / 切换活跃（连载复播） -->
      <section class="bv-kp__block">
        <h3 class="bv-kp__title">会话管理</h3>
        <div class="bv-kp__row">
          <input
            v-model="moduleId"
            class="bv-kp__input"
            placeholder="新场次模组 ID"
            @keydown.enter="startSession"
          />
          <button
            class="bv-kp__btn"
            type="button"
            :disabled="!moduleId.trim()"
            @click="startSession"
          >
            开新场次
          </button>
        </div>
        <div class="bv-kp__row">
          <button
            class="bv-kp__btn bv-kp__btn--ghost"
            type="button"
            :disabled="store.sessionsLoading"
            @click="refreshSessions"
          >
            {{ store.sessionsLoading ? '读取中…' : '刷新会话列表' }}
          </button>
        </div>
        <p v-if="store.sessions.length === 0" class="bv-kp__hint">
          还没有会话数据（先填令牌再刷新）。
        </p>
        <ul v-else class="bv-kp__list">
          <li v-for="session in store.sessions" :key="session.id" class="bv-kp__session">
            <div class="bv-kp__row">
              <code class="bv-kp__mono">{{ session.id }}</code>
              <span
                class="bv-kp__badge"
                :class="{ 'bv-kp__badge--live': session.endedAt === null }"
              >
                {{ sessionStateLabel(session) }}
              </span>
            </div>
            <p class="bv-kp__hint">
              {{ session.moduleRef }} · 开团 {{ formatIsoShort(session.startedAt) }}
            </p>
            <div class="bv-kp__row">
              <button
                class="bv-kp__btn bv-kp__btn--ghost"
                type="button"
                :disabled="session.id === store.activeSessionId"
                @click="store.activateSession(session.id)"
              >
                {{ session.id === store.activeSessionId ? '当前活跃' : '切换为活跃' }}
              </button>
              <button
                class="bv-kp__btn bv-kp__btn--ghost"
                type="button"
                :disabled="session.endedAt !== null"
                @click="store.endSession(session.id)"
              >
                结束
              </button>
            </div>
          </li>
        </ul>
      </section>

      <!-- prompt 预览全量：各阶段用量 / 世界书命中 / 裁剪 / 硬顶 / messages 全文 -->
      <section class="bv-kp__block">
        <h3 class="bv-kp__title">Prompt 预览</h3>
        <button
          class="bv-kp__btn"
          type="button"
          :disabled="!store.activeSessionId || store.previewLoading"
          @click="store.requestPreview()"
        >
          {{ store.previewLoading ? '生成中…' : '生成预览' }}
        </button>

        <template v-if="summary">
          <h4 class="bv-kp__sub">各阶段 token</h4>
          <ul class="bv-kp__list">
            <li v-for="stage in summary.stages" :key="stage.name" class="bv-kp__kv">
              <span>{{ stage.label }}</span>
              <span class="bv-kp__mono">{{ formatTokenCount(stage.tokenCount) }}</span>
            </li>
          </ul>

          <h4 class="bv-kp__sub">世界书命中（{{ summary.hits.length }}）</h4>
          <p v-if="summary.hits.length === 0" class="bv-kp__hint">无命中条目</p>
          <ul v-else class="bv-kp__list">
            <li v-for="hit in summary.hits" :key="hit.uid" class="bv-kp__hit">
              <span class="bv-kp__mono">#{{ hit.uid }}</span>
              <span v-if="hit.kpOnly" class="bv-kp__badge">KP</span>
              <span v-if="!hit.included" class="bv-kp__badge bv-kp__badge--dropped">被裁</span>
              <span class="bv-kp__keys">{{ formatHitKeywords(hit) }}</span>
            </li>
          </ul>

          <h4 class="bv-kp__sub">预算裁剪</h4>
          <p class="bv-kp__hint">
            预算
            <span class="bv-kp__mono">{{ formatTokenCount(summary.budget.budgetTokens) }}</span> ·
            已用
            <span class="bv-kp__mono">{{ formatTokenCount(summary.budget.usedTokens) }}</span> ·
            装入 {{ summary.budget.includedUids.length }} 条 · 被裁
            {{ summary.budget.droppedUids.length }} 条<template
              v-if="summary.budget.droppedUids.length > 0"
            >
              （<span class="bv-kp__mono">{{
                summary.budget.droppedUids.map((uid) => `#${uid}`).join('、')
              }}</span
              >）</template
            >
          </p>

          <h4 class="bv-kp__sub">历史裁剪</h4>
          <p class="bv-kp__hint">
            共 {{ summary.history.total }} 条 · 保留
            <span class="bv-kp__mono">{{ summary.history.kept }}</span> · 裁掉
            {{ summary.history.trimmed
            }}<template v-if="summary.history.synopsisInjected"> · 已注入梗概</template>
          </p>

          <h4 class="bv-kp__sub">硬顶校验</h4>
          <p class="bv-kp__hint">
            总 <span class="bv-kp__mono">{{ formatTokenCount(summary.validate.totalTokens) }}</span>
            <template v-if="summary.validate.hardCap !== null">
              / 硬顶
              <span class="bv-kp__mono">{{ formatTokenCount(summary.validate.hardCap) }}</span>
            </template>
            <span v-if="summary.validate.overBudget" class="bv-kp__over"> · 超限</span>
            <template v-if="summary.validate.fallbackRounds > 0">
              · 回退 {{ summary.validate.fallbackRounds }} 轮
            </template>
          </p>

          <h4 class="bv-kp__sub">最终 messages（{{ summary.messages.length }}）</h4>
          <details v-for="(message, index) in summary.messages" :key="index" class="bv-kp__msg">
            <summary>{{ message.role }} · {{ formatTokenCount(message.charCount) }} 字</summary>
            <pre>{{ message.content }}</pre>
          </details>
        </template>
        <p v-else class="bv-kp__hint">
          开团后可预览每次 AI 请求的 prompt 组装（各阶段 token、世界书命中、最终 messages）。
        </p>
      </section>

      <!-- LLM 参数：temperature / 裁剪窗 / 世界书预算 -->
      <section class="bv-kp__block">
        <h3 class="bv-kp__title">LLM 参数</h3>
        <p v-if="!currentSettings" class="bv-kp__hint">
          读取当前设置需要先填入管理令牌并刷新会话列表；拿不到当前值时填写即照发。
        </p>

        <label class="bv-kp__field">
          <span>temperature（0–2）</span>
          <input
            v-model="draft.temperature"
            class="bv-kp__input bv-kp__mono"
            type="number"
            step="0.1"
            min="0"
            max="2"
          />
        </label>
        <p v-if="parsed.errors.temperature" class="bv-kp__err">{{ parsed.errors.temperature }}</p>

        <label class="bv-kp__field">
          <span>裁剪窗 maxHistoryMessages（正整数）</span>
          <input
            v-model="draft.maxHistoryMessages"
            class="bv-kp__input bv-kp__mono"
            type="number"
            step="1"
            min="1"
          />
        </label>
        <p v-if="parsed.errors.maxHistoryMessages" class="bv-kp__err">
          {{ parsed.errors.maxHistoryMessages }}
        </p>

        <label class="bv-kp__field">
          <span>世界书预算 worldBookBudgetTokens（非负整数）</span>
          <input
            v-model="draft.worldBookBudgetTokens"
            class="bv-kp__input bv-kp__mono"
            type="number"
            step="100"
            min="0"
          />
        </label>
        <p v-if="parsed.errors.worldBookBudgetTokens" class="bv-kp__err">
          {{ parsed.errors.worldBookBudgetTokens }}
        </p>

        <label class="bv-kp__field">
          <span>nat20 / nat1 适用面（5e）</span>
          <select v-model="draft.nat20Rule" class="bv-kp__input">
            <option value="attack_only">仅攻击骰（官方口径）</option>
            <option value="all_d20">所有 d20 检定（桌面房规）</option>
          </select>
        </label>
        <p class="bv-kp__hint">
          COC 房改这项不影响判定；5e 房里它决定 nat20 必中 / nat1 必失是否覆盖属性检定与豁免。
        </p>

        <button class="bv-kp__btn" type="button" :disabled="!canSaveSettings" @click="saveSettings">
          保存并生效
        </button>
        <p class="bv-kp__hint">保存后写回 session.json，下一次 AI 调用即生效。</p>
      </section>

      <!-- token 累计与成本（R-02 防控） -->
      <section class="bv-kp__block">
        <h3 class="bv-kp__title">Token 与成本（本会话）</h3>
        <button
          class="bv-kp__btn"
          type="button"
          :disabled="!store.activeSessionId || store.metricsLoading"
          @click="store.requestMetrics()"
        >
          {{ store.metricsLoading ? '读取中…' : '刷新指标' }}
        </button>

        <template v-if="store.metrics">
          <ul class="bv-kp__list">
            <li class="bv-kp__kv">
              <span>输入 tokens</span>
              <span class="bv-kp__mono">{{ formatTokenCount(store.metrics.llm.tokensIn) }}</span>
            </li>
            <li class="bv-kp__kv">
              <span>输出 tokens</span>
              <span class="bv-kp__mono">{{ formatTokenCount(store.metrics.llm.tokensOut) }}</span>
            </li>
            <li class="bv-kp__kv">
              <span>合计</span>
              <span class="bv-kp__mono">{{ formatTokenCount(tokenTotal ?? 0) }}</span>
            </li>
            <li class="bv-kp__kv">
              <span>估算费用</span>
              <span class="bv-kp__mono">{{ formatCostCny(store.metrics.cost.estimatedCny) }}</span>
            </li>
            <li class="bv-kp__kv">
              <span>LLM 调用 / 失败</span>
              <span class="bv-kp__mono">
                {{ store.metrics.llm.calls }} / {{ store.metrics.llm.failures }}
              </span>
            </li>
            <li class="bv-kp__kv">
              <span>延迟 p50 / p95</span>
              <span class="bv-kp__mono">
                {{ formatLatency(store.metrics.llm.latencyMs.p50) }} /
                {{ formatLatency(store.metrics.llm.latencyMs.p95) }}
              </span>
            </li>
            <li class="bv-kp__kv">
              <span>延迟 max / avg</span>
              <span class="bv-kp__mono">
                {{ formatLatency(store.metrics.llm.latencyMs.max) }} /
                {{ formatLatency(store.metrics.llm.latencyMs.avg) }}
              </span>
            </li>
            <li class="bv-kp__kv">
              <span>指令成功率</span>
              <span class="bv-kp__mono">
                {{ formatPercent(store.metrics.directives.rate) }}（{{
                  store.metrics.directives.successes
                }}/{{ store.metrics.directives.attempts }}）
              </span>
            </li>
            <li class="bv-kp__kv">
              <span>掷骰 / 暗骰</span>
              <span class="bv-kp__mono">
                {{ store.metrics.dice.total }} / {{ store.metrics.dice.hidden }}
              </span>
            </li>
          </ul>
          <p class="bv-kp__hint">
            会话 <span class="bv-kp__mono">{{ store.metrics.sessionId }}</span>
          </p>
        </template>
        <p v-else class="bv-kp__hint">尚未读取指标。</p>
      </section>
    </template>
  </div>
</template>

<style scoped>
/* 配色只取 tokens.css 变量；数值一律用 --bv-font-mono（等宽，便于对齐核对） */
.bv-kp {
  display: flex;
  flex-direction: column;
  gap: var(--bv-space-4);
  font-size: 13px;
}
.bv-kp__block {
  display: flex;
  flex-direction: column;
  gap: var(--bv-space-2);
  padding-bottom: var(--bv-space-4);
  border-bottom: 1px solid var(--bv-line-subtle);
}
.bv-kp__block:last-child {
  border-bottom: none;
  padding-bottom: 0;
}
.bv-kp__title {
  margin: 0;
  font-size: 12px;
  letter-spacing: 0.1em;
  color: var(--bv-text-tertiary);
}
.bv-kp__sub {
  margin: var(--bv-space-2) 0 0;
  font-size: 12px;
  color: var(--bv-text-secondary);
}
.bv-kp__hint {
  margin: 0;
  font-size: 12px;
  color: var(--bv-text-tertiary);
}
.bv-kp__row {
  display: flex;
  align-items: center;
  gap: var(--bv-space-2);
}
.bv-kp__list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--bv-space-1);
}
.bv-kp__kv {
  display: flex;
  justify-content: space-between;
  gap: var(--bv-space-2);
  font-size: 12px;
  color: var(--bv-text-secondary);
}
.bv-kp__session {
  display: flex;
  flex-direction: column;
  gap: var(--bv-space-1);
  padding: var(--bv-space-2);
  border: 1px solid var(--bv-line-subtle);
  border-radius: var(--bv-radius-card);
  background: var(--bv-bg-elevated);
}
.bv-kp__hit {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--bv-space-1);
  font-size: 12px;
  color: var(--bv-text-secondary);
}
.bv-kp__keys {
  color: var(--bv-text-tertiary);
}
.bv-kp__input {
  flex: 1;
  min-width: 0;
  padding: var(--bv-space-2);
  border: 1px solid var(--bv-line-subtle);
  border-radius: var(--bv-radius-control);
  background: var(--bv-bg-elevated);
  color: var(--bv-text-primary);
  font: inherit;
}
.bv-kp__field {
  display: flex;
  flex-direction: column;
  gap: var(--bv-space-1);
  font-size: 12px;
  color: var(--bv-text-secondary);
}
.bv-kp__btn {
  padding: var(--bv-space-2) var(--bv-space-3);
  border: none;
  border-radius: var(--bv-radius-control);
  background: var(--bv-accent);
  color: var(--bv-bg-canvas);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.bv-kp__btn--ghost {
  border: 1px solid var(--bv-line-strong);
  background: transparent;
  color: var(--bv-text-secondary);
  font-weight: 400;
}
.bv-kp__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.bv-kp__badge {
  padding: 1px var(--bv-space-2);
  border-radius: var(--bv-radius-pill);
  background: var(--bv-bg-sunken);
  color: var(--bv-text-tertiary);
  font-size: 11px;
}
.bv-kp__badge--live {
  background: var(--bv-accent);
  color: var(--bv-bg-canvas);
}
.bv-kp__badge--dropped {
  border: 1px solid var(--bv-line-strong);
}
.bv-kp__mono {
  font-family: var(--bv-font-mono);
}
.bv-kp__over,
.bv-kp__err {
  color: var(--bv-accent-lift);
}
.bv-kp__err {
  margin: 0;
  font-size: 11px;
}
.bv-kp__msg {
  font-size: 12px;
  color: var(--bv-text-secondary);
}
.bv-kp__msg pre {
  margin: var(--bv-space-1) 0 0;
  padding: var(--bv-space-2);
  max-height: 240px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
  border: 1px solid var(--bv-line-subtle);
  border-radius: var(--bv-radius-card);
  background: var(--bv-bg-elevated);
  font-size: 11px;
}
</style>
