<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { WorldBookEntry } from '@behindveil/shared';
import { useSessionStore } from '../stores/session';
import {
  POSITION_LABELS,
  SELECTIVE_LOGIC_LABELS,
  copyIntoRoom,
  draftFromEntry,
  emptyDraft,
  entryFromDraft,
  nextUid,
  validateDraft,
  virtualWindow,
  type EntryDraft,
} from '../worldbook.js';

/**
 * 世界书编辑器（v3 T-M11-06，FR-35）。
 *
 * 房间层可读写，模组层只读（模组包是外部资产，要改就「复制到房间」再编辑——
 * 复制产生的 uid 重排在 worldbook.ts 里，服务端不做这个语义）。
 *
 * 列表走虚拟滚动：大世界书（社区模组常上千条目）全量挂载会把房间页拖垮，
 * 固定行高 + 只渲染视口内的行，1000 条目也只挂 ~20 个 DOM 节点。
 */

const store = useSessionStore();

const ROW_HEIGHT = 40;
const VIEWPORT_HEIGHT = 360;
/** 超过这个条数才启用虚拟滚动（小世界书直接全渲染，省一层间接） */
const VIRTUAL_THRESHOLD = 500;

const entries = ref<WorldBookEntry[]>([]);
const loading = ref(false);
const saving = ref(false);
const error = ref('');
const notice = ref('');
const warnings = ref<string[]>([]);

// ---- 列表与虚拟滚动 ----
const scrollTop = ref(0);
const selectedIndex = ref<number | null>(null);

const virtual = computed(() => ({
  enabled: entries.value.length > VIRTUAL_THRESHOLD,
  window: virtualWindow({
    itemCount: entries.value.length,
    rowHeight: ROW_HEIGHT,
    scrollTop: scrollTop.value,
    viewportHeight: VIEWPORT_HEIGHT,
  }),
}));

/** 实际渲染的行（虚拟滚动开启时只取窗口内的一段） */
const visibleRows = computed(() => {
  if (!virtual.value.enabled) {
    return entries.value.map((entry, index) => ({ entry, index }));
  }
  const { start, end } = virtual.value.window;
  const rows: Array<{ entry: WorldBookEntry; index: number }> = [];
  for (let i = start; i <= end; i += 1) {
    const entry = entries.value[i];
    if (entry) rows.push({ entry, index: i });
  }
  return rows;
});

function onScroll(event: Event): void {
  const el = event.target as HTMLElement;
  scrollTop.value = el.scrollTop;
}

// ---- 编辑表单 ----
const draft = ref<EntryDraft | null>(null);
const draftErrors = computed(() => (draft.value ? validateDraft(draft.value) : {}));

function select(index: number): void {
  const entry = entries.value[index];
  if (!entry) return;
  selectedIndex.value = index;
  draft.value = draftFromEntry(entry);
}

function addEntry(): void {
  const created = emptyDraft(nextUid(entries.value));
  entries.value.push(entryFromDraft(created));
  selectedIndex.value = entries.value.length - 1;
  draft.value = created;
  notice.value = `已新增条目 #${created.uid}（保存后生效）`;
}

function removeSelected(): void {
  if (selectedIndex.value === null) return;
  const removed = entries.value[selectedIndex.value];
  entries.value.splice(selectedIndex.value, 1);
  draft.value = null;
  selectedIndex.value = null;
  if (removed) notice.value = `已移除条目 #${removed.uid}（保存后生效）`;
}

/** 表单改动写回列表（列表是保存的唯一数据源，表单只是它的投影） */
function syncDraft(): void {
  if (!draft.value || selectedIndex.value === null) return;
  entries.value[selectedIndex.value] = entryFromDraft(draft.value);
}

watch(
  draft,
  () => {
    syncDraft();
  },
  { deep: true },
);

// ---- 读写 ----
async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const res = await fetch(`/rooms/${store.roomId}/worldbook`, {
      headers: store.adminToken ? { 'X-Admin-Token': store.adminToken } : {},
    });
    const payload: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(
        typeof payload === 'object' &&
          payload !== null &&
          typeof (payload as { message?: unknown }).message === 'string'
          ? (payload as { message: string }).message
          : `读取失败（${res.status}）`,
      );
    }
    const list = (payload as { entries?: unknown }).entries;
    entries.value = Array.isArray(list) ? (list as WorldBookEntry[]) : [];
    warnings.value = Array.isArray((payload as { warnings?: unknown }).warnings)
      ? ((payload as { warnings: string[] }).warnings ?? [])
      : [];
    draft.value = null;
    selectedIndex.value = null;
  } catch (err) {
    error.value = err instanceof Error ? err.message : '读取失败';
  } finally {
    loading.value = false;
  }
}

async function save(): Promise<void> {
  if (draft.value) syncDraft();
  saving.value = true;
  error.value = '';
  notice.value = '';
  try {
    const res = await fetch(`/rooms/${store.roomId}/worldbook`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(store.adminToken ? { 'X-Admin-Token': store.adminToken } : {}),
      },
      body: JSON.stringify({ entries: entries.value }),
    });
    const payload: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(
        typeof payload === 'object' &&
          payload !== null &&
          typeof (payload as { message?: unknown }).message === 'string'
          ? (payload as { message: string }).message
          : `保存失败（${res.status}）`,
      );
    }
    warnings.value = Array.isArray((payload as { warnings?: unknown }).warnings)
      ? ((payload as { warnings: string[] }).warnings ?? [])
      : [];
    notice.value = `已保存 ${entries.value.length} 条条目`;
  } catch (err) {
    error.value = err instanceof Error ? err.message : '保存失败';
  } finally {
    saving.value = false;
  }
}

// ---- 模组层只读 + 复制到房间 ----
const moduleId = ref('');
const moduleEntries = ref<WorldBookEntry[]>([]);
const moduleLoading = ref(false);

async function loadModuleBook(): Promise<void> {
  const id = moduleId.value.trim();
  if (id === '') return;
  moduleLoading.value = true;
  error.value = '';
  try {
    const res = await fetch(`/modules/${encodeURIComponent(id)}/worldbook`, {
      headers: store.adminToken ? { 'X-Admin-Token': store.adminToken } : {},
    });
    const payload: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(
        typeof payload === 'object' &&
          payload !== null &&
          typeof (payload as { message?: unknown }).message === 'string'
          ? (payload as { message: string }).message
          : `读取模组世界书失败（${res.status}）`,
      );
    }
    const list = (payload as { entries?: unknown }).entries;
    moduleEntries.value = Array.isArray(list) ? (list as WorldBookEntry[]) : [];
  } catch (err) {
    moduleEntries.value = [];
    error.value = err instanceof Error ? err.message : '读取模组世界书失败';
  } finally {
    moduleLoading.value = false;
  }
}

function copyFromModule(): void {
  if (moduleEntries.value.length === 0) return;
  const result = copyIntoRoom(entries.value, moduleEntries.value);
  entries.value = result.entries;
  notice.value =
    result.added === 0
      ? '模组条目已在房间世界书中，未重复复制'
      : `已复制 ${result.added} 条到房间（uid 重排，保存后生效）`;
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="bv-wb">
    <p v-if="store.role !== 'host'" class="bv-wb__hint">世界书编辑器仅 Host 可见。</p>

    <template v-else>
      <section class="bv-wb__block">
        <div class="bv-wb__row">
          <button class="bv-wb__btn" type="button" :disabled="loading" @click="load">
            {{ loading ? '读取中…' : '重新读取' }}
          </button>
          <button class="bv-wb__btn" type="button" :disabled="saving" @click="save">
            {{ saving ? '保存中…' : '保存' }}
          </button>
          <span class="bv-wb__count">共 {{ entries.length }} 条</span>
        </div>
        <p class="bv-wb__hint">
          改动先在列表里生效，点「保存」才写盘（校验不通过会拒绝保存并给出定位）。
        </p>
        <p v-if="error" class="bv-wb__err">{{ error }}</p>
        <p v-else-if="notice" class="bv-wb__hint">{{ notice }}</p>
        <ul v-if="warnings.length > 0" class="bv-wb__list">
          <li v-for="warning in warnings" :key="warning" class="bv-wb__hint">⚠ {{ warning }}</li>
        </ul>
      </section>

      <!-- 条目列表：>500 条自动转虚拟滚动 -->
      <section class="bv-wb__block">
        <div class="bv-wb__row">
          <h3 class="bv-wb__title">条目</h3>
          <button class="bv-wb__btn bv-wb__btn--ghost" type="button" @click="addEntry">新增</button>
          <button
            class="bv-wb__btn bv-wb__btn--ghost"
            type="button"
            :disabled="selectedIndex === null"
            @click="removeSelected"
          >
            删除
          </button>
        </div>
        <div
          class="bv-wb__list-scroll"
          :style="{ height: `${VIEWPORT_HEIGHT}px` }"
          @scroll="onScroll"
        >
          <div
            v-if="virtual.enabled"
            class="bv-wb__spacer"
            :style="{ height: `${virtual.window.totalHeight}px` }"
          >
            <div :style="{ transform: `translateY(${virtual.window.offsetTop}px)` }">
              <button
                v-for="row in visibleRows"
                :key="row.entry.uid"
                type="button"
                class="bv-wb__row-item"
                :class="{ 'bv-wb__row-item--active': row.index === selectedIndex }"
                :style="{ height: `${ROW_HEIGHT}px` }"
                @click="select(row.index)"
              >
                <span class="bv-wb__mono">#{{ row.entry.uid }}</span>
                <span class="bv-wb__keys">{{ row.entry.key.join('、') || '（常驻）' }}</span>
                <span v-if="row.entry.disabled" class="bv-wb__badge">停用</span>
                <span v-if="row.entry.extensions?.kpOnly" class="bv-wb__badge">KP</span>
              </button>
            </div>
          </div>
          <template v-else>
            <button
              v-for="row in visibleRows"
              :key="row.entry.uid"
              type="button"
              class="bv-wb__row-item"
              :class="{ 'bv-wb__row-item--active': row.index === selectedIndex }"
              :style="{ height: `${ROW_HEIGHT}px` }"
              @click="select(row.index)"
            >
              <span class="bv-wb__mono">#{{ row.entry.uid }}</span>
              <span class="bv-wb__keys">{{ row.entry.key.join('、') || '（常驻）' }}</span>
              <span v-if="row.entry.disabled" class="bv-wb__badge">停用</span>
              <span v-if="row.entry.extensions?.kpOnly" class="bv-wb__badge">KP</span>
            </button>
          </template>
        </div>
        <p v-if="entries.length === 0" class="bv-wb__hint">本房还没有世界书条目。</p>
      </section>

      <!-- 条目编辑 -->
      <section v-if="draft" class="bv-wb__block">
        <h3 class="bv-wb__title">编辑 #{{ draft.uid }}</h3>

        <label class="bv-wb__field">
          <span>主关键词（逗号分隔，支持 /正则/）</span>
          <input v-model="draft.keyText" class="bv-wb__input" />
        </label>
        <label class="bv-wb__field">
          <span>二级关键词（逗号分隔）</span>
          <input v-model="draft.keysecondaryText" class="bv-wb__input" />
        </label>
        <label class="bv-wb__field">
          <span>匹配逻辑</span>
          <select v-model.number="draft.selectiveLogic" class="bv-wb__input">
            <option v-for="n in [0, 1, 2, 3]" :key="n" :value="n">
              {{ SELECTIVE_LOGIC_LABELS[n] }}
            </option>
          </select>
        </label>
        <label class="bv-wb__field">
          <span>内容</span>
          <textarea v-model="draft.content" class="bv-wb__input bv-wb__area" rows="6" />
        </label>
        <p v-if="draftErrors.content" class="bv-wb__err">{{ draftErrors.content }}</p>

        <div class="bv-wb__row">
          <label class="bv-wb__field">
            <span>插入位置</span>
            <select v-model="draft.position" class="bv-wb__input">
              <option v-for="(label, value) in POSITION_LABELS" :key="value" :value="value">
                {{ label }}
              </option>
            </select>
          </label>
          <label class="bv-wb__field">
            <span>深度（at_depth）</span>
            <input v-model="draft.depth" class="bv-wb__input bv-wb__mono" type="number" min="0" />
          </label>
        </div>
        <p v-if="draftErrors.depth" class="bv-wb__err">{{ draftErrors.depth }}</p>

        <div class="bv-wb__row">
          <label class="bv-wb__field">
            <span>排序 order</span>
            <input v-model.number="draft.order" class="bv-wb__input bv-wb__mono" type="number" />
          </label>
          <label class="bv-wb__field">
            <span>权重 weight</span>
            <input v-model.number="draft.weight" class="bv-wb__input bv-wb__mono" type="number" />
          </label>
        </div>

        <label class="bv-wb__check">
          <input v-model="draft.constant" type="checkbox" />
          <span>常驻注入（无需关键词匹配）</span>
        </label>
        <label class="bv-wb__check">
          <input v-model="draft.disabled" type="checkbox" />
          <span>停用本条目</span>
        </label>
        <label class="bv-wb__check">
          <input v-model="draft.kpOnly" type="checkbox" />
          <span>KP 专属（只进 prompt，不给玩家看）</span>
        </label>
        <p v-if="draftErrors.notice" class="bv-wb__hint">⚠ {{ draftErrors.notice }}</p>
      </section>
      <p v-else class="bv-wb__hint">选择左侧条目开始编辑。</p>

      <!-- 模组层世界书：只读 + 复制到房间 -->
      <section class="bv-wb__block">
        <h3 class="bv-wb__title">模组世界书（只读）</h3>
        <div class="bv-wb__row">
          <input v-model="moduleId" class="bv-wb__input" placeholder="模组 ID" />
          <button
            class="bv-wb__btn bv-wb__btn--ghost"
            type="button"
            :disabled="moduleLoading || !moduleId.trim()"
            @click="loadModuleBook"
          >
            {{ moduleLoading ? '读取中…' : '读取' }}
          </button>
        </div>
        <p class="bv-wb__hint">
          模组包是外部资产，不能直接改；复制到房间层后随意编辑（uid 会自动重排）。
        </p>
        <p v-if="moduleEntries.length > 0" class="bv-wb__hint">
          模组共 {{ moduleEntries.length }} 条。
          <button class="bv-wb__btn bv-wb__btn--ghost" type="button" @click="copyFromModule">
            复制到房间
          </button>
        </p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.bv-wb {
  display: flex;
  flex-direction: column;
  gap: var(--bv-space-4);
  font-size: 13px;
}
.bv-wb__block {
  display: flex;
  flex-direction: column;
  gap: var(--bv-space-2);
  padding-bottom: var(--bv-space-4);
  border-bottom: 1px solid var(--bv-line-subtle);
}
.bv-wb__block:last-child {
  border-bottom: none;
  padding-bottom: 0;
}
.bv-wb__title {
  margin: 0;
  font-size: 12px;
  letter-spacing: 0.1em;
  color: var(--bv-text-tertiary);
}
.bv-wb__hint {
  margin: 0;
  font-size: 12px;
  color: var(--bv-text-tertiary);
}
.bv-wb__row {
  display: flex;
  align-items: center;
  gap: var(--bv-space-2);
}
.bv-wb__list {
  margin: 0;
  padding-left: var(--bv-space-4);
}
.bv-wb__count {
  font-size: 12px;
  color: var(--bv-text-tertiary);
}
.bv-wb__list-scroll {
  overflow-y: auto;
  border: 1px solid var(--bv-line-subtle);
  border-radius: var(--bv-radius-card);
  background: var(--bv-bg-sunken);
}
.bv-wb__spacer {
  position: relative;
}
.bv-wb__row-item {
  display: flex;
  align-items: center;
  gap: var(--bv-space-2);
  width: 100%;
  padding: 0 var(--bv-space-2);
  border: none;
  border-bottom: 1px solid var(--bv-line-subtle);
  background: transparent;
  color: var(--bv-text-secondary);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.bv-wb__row-item--active {
  background: var(--bv-bg-elevated);
  color: var(--bv-text-primary);
}
.bv-wb__keys {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--bv-text-tertiary);
}
.bv-wb__badge {
  padding: 1px var(--bv-space-2);
  border-radius: var(--bv-radius-pill);
  background: var(--bv-bg-elevated);
  color: var(--bv-text-tertiary);
  font-size: 11px;
}
.bv-wb__input {
  flex: 1;
  min-width: 0;
  padding: var(--bv-space-2);
  border: 1px solid var(--bv-line-subtle);
  border-radius: var(--bv-radius-control);
  background: var(--bv-bg-elevated);
  color: var(--bv-text-primary);
  font: inherit;
}
.bv-wb__area {
  resize: vertical;
}
.bv-wb__field {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--bv-space-1);
  font-size: 12px;
  color: var(--bv-text-secondary);
}
.bv-wb__check {
  display: flex;
  align-items: center;
  gap: var(--bv-space-2);
  font-size: 12px;
  color: var(--bv-text-secondary);
}
.bv-wb__btn {
  padding: var(--bv-space-2) var(--bv-space-3);
  border: none;
  border-radius: var(--bv-radius-control);
  background: var(--bv-accent);
  color: var(--bv-bg-canvas);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.bv-wb__btn--ghost {
  border: 1px solid var(--bv-line-strong);
  background: transparent;
  color: var(--bv-text-secondary);
  font-weight: 400;
}
.bv-wb__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.bv-wb__mono {
  font-family: var(--bv-font-mono);
}
.bv-wb__err {
  margin: 0;
  font-size: 11px;
  color: var(--bv-accent-lift);
}
</style>
