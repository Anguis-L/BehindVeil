<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useSessionStore } from '../stores/session';
import { readAdminToken } from '../admin-token';
import type { CardEntry, PCSheet } from '@behindveil/shared';

/**
 * 卡库与 PC 声明面板（T-M5-10，FR-08）：导入社区卡（PNG/JSON 原样上传）、
 * 管理卡库，Host 把玩家卡声明到成员（cardId 路径）或速建表（粘贴 PCSheet JSON）。
 * 卡库与声明均走管理面 REST（X-Admin-Token，决议 ②）。
 */

const store = useSessionStore();

const cards = ref<CardEntry[]>([]);
const declared = ref<Array<{ memberId: string; source: string; cardId?: string; sheet: PCSheet }>>(
  [],
);
const busy = ref(false);
const notice = ref('');

// 声明表单
const declareMemberId = ref('');
const declareCardId = ref('');
const manualSheetJson = ref('');

const pcCards = computed(() => cards.value.filter((c) => c.kind === 'pc'));
const memberOptions = computed(() => store.members.map((m) => ({ id: m.id, name: m.name })));

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '请求失败';
}

async function authed<T>(path: string, method: string, body?: unknown): Promise<T> {
  const token = readAdminToken();
  const res = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Admin-Token': token } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      typeof payload === 'object' &&
      payload !== null &&
      typeof (payload as { message?: unknown }).message === 'string'
        ? (payload as { message: string }).message
        : `请求失败（${res.status}）`;
    throw new Error(res.status === 401 ? `${message}——请在 KP 控制台填写管理令牌` : message);
  }
  return payload as T;
}

async function refresh(): Promise<void> {
  busy.value = true;
  try {
    cards.value = await authed<CardEntry[]>('/cards', 'GET');
    if (store.roomId) {
      declared.value = await authed(`/rooms/${store.roomId}/pcs`, 'GET');
    }
    notice.value = '';
  } catch (error) {
    notice.value = messageOf(error);
  } finally {
    busy.value = false;
  }
}

onMounted(() => {
  void refresh();
});

async function upload(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ''; // 允许重复选同一文件
  if (!file) return;
  busy.value = true;
  notice.value = '';
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    await authed('/cards', 'POST', {
      fileName: file.name,
      contentBase64: btoa(binary),
    });
    await refresh();
  } catch (error) {
    notice.value = `导入失败：${messageOf(error)}`;
  } finally {
    busy.value = false;
  }
}

async function remove(cardId: string): Promise<void> {
  busy.value = true;
  try {
    await authed(`/cards/${encodeURIComponent(cardId)}`, 'DELETE');
    await refresh();
  } catch (error) {
    notice.value = messageOf(error);
  } finally {
    busy.value = false;
  }
}

async function declareByCard(): Promise<void> {
  if (!store.roomId || !declareMemberId.value || !declareCardId.value) return;
  busy.value = true;
  notice.value = '';
  try {
    await authed(`/rooms/${store.roomId}/pcs/${declareMemberId.value}`, 'PUT', {
      cardId: declareCardId.value,
    });
    declareCardId.value = '';
    await refresh();
  } catch (error) {
    notice.value = `声明失败：${messageOf(error)}`;
  } finally {
    busy.value = false;
  }
}

async function declareBySheet(): Promise<void> {
  if (!store.roomId || !declareMemberId.value) return;
  let sheet: unknown;
  try {
    sheet = JSON.parse(manualSheetJson.value);
  } catch {
    notice.value = '速建表不是合法 JSON';
    return;
  }
  busy.value = true;
  notice.value = '';
  try {
    await authed(`/rooms/${store.roomId}/pcs/${declareMemberId.value}`, 'PUT', { sheet });
    manualSheetJson.value = '';
    await refresh();
  } catch (error) {
    notice.value = `声明失败：${messageOf(error)}`;
  } finally {
    busy.value = false;
  }
}

async function undeclare(memberId: string): Promise<void> {
  if (!store.roomId) return;
  busy.value = true;
  try {
    await authed(`/rooms/${store.roomId}/pcs/${memberId}`, 'DELETE');
    await refresh();
  } catch (error) {
    notice.value = messageOf(error);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="bv-cards">
    <header class="bv-cards__head">
      <h2 class="bv-cards__title">卡库</h2>
      <label class="bv-cards__upload">
        <input type="file" accept=".png,.json" :disabled="busy" @change="upload" />
      </label>
    </header>

    <p v-if="notice" class="bv-cards__notice">{{ notice }}</p>

    <ul class="bv-cards__list">
      <li v-for="card in cards" :key="card.id" class="bv-cards__card">
        <span class="bv-cards__card-name">{{ card.name }}</span>
        <span class="bv-cards__card-meta">
          {{ card.kind === 'pc' ? '玩家卡' : 'KP 卡' }} · {{ card.rulebook ?? '规则书未标注' }}
        </span>
        <button
          class="bv-cards__btn bv-cards__btn--ghost"
          :disabled="busy"
          @click="remove(card.id)"
        >
          删除
        </button>
      </li>
    </ul>
    <p v-if="cards.length === 0 && !busy" class="bv-cards__hint">
      还没有卡——上传社区 PNG/JSON 角色卡（原样保存）。
    </p>

    <h3 class="bv-cards__section">已声明 PC（{{ declared.length }}）</h3>
    <ul class="bv-cards__list">
      <li v-for="d in declared" :key="d.memberId" class="bv-cards__card">
        <span class="bv-cards__card-name">{{ d.sheet.playerName }}</span>
        <span class="bv-cards__card-meta">
          {{ d.source === 'card' ? `来自卡 ${d.cardId}` : '速建表' }}
        </span>
        <button
          class="bv-cards__btn bv-cards__btn--ghost"
          :disabled="busy"
          @click="undeclare(d.memberId)"
        >
          撤销
        </button>
      </li>
    </ul>
    <p v-if="declared.length === 0" class="bv-cards__hint">
      尚未声明——开团前把玩家卡绑到成员，随开团进状态板。
    </p>

    <h3 class="bv-cards__section">声明 PC</h3>
    <div class="bv-cards__row">
      <select v-model="declareMemberId" class="bv-cards__select">
        <option value="" disabled>选择成员</option>
        <option v-for="m in memberOptions" :key="m.id" :value="m.id">{{ m.name }}</option>
      </select>
      <select v-model="declareCardId" class="bv-cards__select">
        <option value="" disabled>选择玩家卡</option>
        <option v-for="c in pcCards" :key="c.id" :value="c.id">{{ c.name }}</option>
      </select>
      <button
        class="bv-cards__btn"
        :disabled="busy || !declareMemberId || !declareCardId"
        @click="declareByCard"
      >
        用卡声明
      </button>
    </div>
    <textarea
      v-model="manualSheetJson"
      class="bv-cards__json"
      rows="4"
      placeholder="无卡速建表：粘贴 PCSheet JSON（playerName/occupation/六维/luck/hp/mp/san/db/build/skills）"
    ></textarea>
    <button
      class="bv-cards__btn"
      :disabled="busy || !declareMemberId || manualSheetJson.trim() === ''"
      @click="declareBySheet"
    >
      用速建表声明
    </button>
  </section>
</template>

<style scoped>
.bv-cards {
  display: flex;
  flex-direction: column;
  gap: var(--bv-space-2);
  font-size: 13px;
}
.bv-cards__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--bv-space-2);
}
.bv-cards__title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.bv-cards__upload input {
  max-width: 200px;
  font-size: 11px;
  color: var(--bv-text-secondary);
}
.bv-cards__notice {
  margin: 0;
  padding: var(--bv-space-2);
  border: 1px solid var(--bv-judge-fail);
  border-radius: var(--bv-radius-card);
  color: var(--bv-judge-fail);
  font-size: 12px;
}
.bv-cards__list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--bv-space-1);
}
.bv-cards__card {
  display: flex;
  align-items: center;
  gap: var(--bv-space-2);
  padding: var(--bv-space-1) var(--bv-space-2);
  border: 1px solid var(--bv-line-subtle);
  border-radius: var(--bv-radius-card);
  background: var(--bv-bg-elevated);
}
.bv-cards__card-name {
  font-weight: 600;
}
.bv-cards__card-meta {
  flex: 1;
  color: var(--bv-text-tertiary);
  font-size: 11px;
}
.bv-cards__section {
  margin: var(--bv-space-2) 0 0;
  font-size: 12px;
  color: var(--bv-text-tertiary);
  letter-spacing: 0.1em;
}
.bv-cards__row {
  display: flex;
  gap: var(--bv-space-2);
}
.bv-cards__select {
  flex: 1;
  min-width: 0;
  padding: var(--bv-space-1) var(--bv-space-2);
  border: 1px solid var(--bv-line-subtle);
  border-radius: var(--bv-radius-card);
  background: var(--bv-bg-elevated);
  color: var(--bv-text-primary);
  font: inherit;
  font-size: 12px;
}
.bv-cards__json {
  width: 100%;
  box-sizing: border-box;
  padding: var(--bv-space-2);
  border: 1px solid var(--bv-line-subtle);
  border-radius: var(--bv-radius-card);
  background: var(--bv-bg-elevated);
  color: var(--bv-text-primary);
  font: ui-monospace, monospace;
  font-size: 11px;
  resize: vertical;
}
.bv-cards__btn {
  padding: var(--bv-space-1) var(--bv-space-3);
  border: none;
  border-radius: var(--bv-radius-card);
  background: var(--bv-accent);
  color: var(--bv-bg-canvas);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.bv-cards__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.bv-cards__btn--ghost {
  background: transparent;
  border: 1px solid var(--bv-line-subtle);
  color: var(--bv-text-secondary);
}
.bv-cards__hint {
  margin: 0;
  color: var(--bv-text-tertiary);
  font-size: 12px;
}
</style>
