<script setup lang="ts">
import { computed, reactive, watch } from 'vue';
import { useSessionStore } from '../stores/session';
import type { PCSheet, StateBoardPc, StatePatch } from '@behindveil/shared';

/**
 * 状态板面板（T-M5-10，FR-09）：全房可见的场景/事实/PC 状态展示；
 * Host 可编辑（scene/facts/PC 数值与状态，走 state:update 乐观锁）并生成快照。
 * 冲突（E-ST-01）时服务端会广播最新版，本地自动对齐——错误横幅提示重试即可。
 */

const store = useSessionStore();

const editable = computed(() => store.role === 'host' && store.stateBoard !== null);

/** 本地编辑草稿：进入编辑时深拷贝当前板，保存时整体作为 patch 提交 */
const draft = reactive<{
  active: boolean;
  scene: { name: string; time: string; publicDesc: string };
  facts: string[];
  newFact: string;
  pcs: Record<string, { san: number; hp: number; mp: number; conditions: string[] }>;
}>({
  active: false,
  scene: { name: '', time: '', publicDesc: '' },
  facts: [],
  newFact: '',
  pcs: {},
});

watch(
  () => store.stateBoard,
  (board) => {
    if (!board || !draft.active) return;
    // 广播到达（自己保存成功 / 他人冲突对齐）时刷新草稿底稿，但保留未保存的输入
    draft.scene = { ...board.scene };
    draft.facts = [...board.facts];
    for (const [id, pc] of Object.entries(board.pcs)) {
      if (draft.pcs[id]) continue; // 编辑中不覆盖已展开的行
      draft.pcs[id] = pickEditable(pc);
    }
  },
);

function pickEditable(pc: StateBoardPc) {
  return {
    san: pc.sheet.san,
    hp: pc.sheet.hp,
    mp: pc.sheet.mp,
    conditions: [...pc.conditions],
  };
}

function beginEdit(): void {
  const board = store.stateBoard;
  if (!board) return;
  draft.active = true;
  draft.scene = { ...board.scene };
  draft.facts = [...board.facts];
  draft.pcs = Object.fromEntries(
    Object.entries(board.pcs).map(([id, pc]) => [id, pickEditable(pc)]),
  );
}

function cancelEdit(): void {
  draft.active = false;
}

function addFact(): void {
  const fact = draft.newFact.trim();
  if (!fact) return;
  draft.facts.push(fact);
  draft.newFact = '';
}

function removeFact(index: number): void {
  draft.facts.splice(index, 1);
}

function save(): void {
  const board = store.stateBoard;
  if (!board) return;
  const patch: StatePatch = {
    scene: { ...draft.scene },
    facts: draft.facts.map((f) => f.trim()).filter((f) => f !== ''),
    pcs: Object.fromEntries(
      Object.entries(board.pcs).map(([id, pc]) => {
        const edited = draft.pcs[id];
        const sheet: PCSheet = edited
          ? { ...pc.sheet, san: num(edited.san), hp: num(edited.hp), mp: num(edited.mp) }
          : pc.sheet;
        return [
          id,
          {
            sheet,
            conditions: edited ? edited.conditions.filter((c) => c.trim() !== '') : pc.conditions,
          },
        ];
      }),
    ),
  };
  store.updateState(patch);
  draft.active = false;
}

function num(value: number | string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

const pcEntries = computed(() => Object.entries(store.stateBoard?.pcs ?? {}));
</script>

<template>
  <section class="bv-board">
    <header class="bv-board__head">
      <h2 class="bv-board__title">状态板</h2>
      <span v-if="store.stateBoard" class="bv-board__version">v{{ store.stateBoard.version }}</span>
      <button
        v-if="editable"
        class="bv-board__btn bv-board__btn--ghost"
        :disabled="!store.activeSessionId"
        @click="store.requestSnapshot()"
      >
        生成快照
      </button>
    </header>

    <p v-if="!store.activeSessionId" class="bv-board__hint">尚未开团——开团后状态板生效。</p>

    <template v-else-if="store.stateBoard">
      <h3 class="bv-board__section">场景</h3>
      <p v-if="!draft.active" class="bv-board__scene">
        <strong>{{ store.stateBoard.scene.name || '（未命名）' }}</strong>
        <span v-if="store.stateBoard.scene.time"> · {{ store.stateBoard.scene.time }}</span>
      </p>
      <p v-if="!draft.active && store.stateBoard.scene.publicDesc" class="bv-board__desc">
        {{ store.stateBoard.scene.publicDesc }}
      </p>
      <div v-if="draft.active" class="bv-board__edit-row">
        <input v-model="draft.scene.name" class="bv-board__input" placeholder="场景名" />
        <input v-model="draft.scene.time" class="bv-board__input" placeholder="时间" />
      </div>
      <textarea
        v-if="draft.active"
        v-model="draft.scene.publicDesc"
        class="bv-board__textarea"
        rows="2"
        placeholder="场景描述"
      ></textarea>

      <h3 class="bv-board__section">已确立事实</h3>
      <ul v-if="store.stateBoard.facts.length > 0 || draft.active" class="bv-board__facts">
        <template v-if="draft.active">
          <li v-for="(fact, i) in draft.facts" :key="`d${i}`" class="bv-board__fact">
            <span>{{ fact }}</span>
            <button class="bv-board__btn bv-board__btn--ghost" type="button" @click="removeFact(i)">
              移除
            </button>
          </li>
          <li class="bv-board__fact bv-board__fact--new">
            <input
              v-model="draft.newFact"
              class="bv-board__input"
              placeholder="补充事实…"
              @keydown.enter.prevent="addFact"
            />
            <button class="bv-board__btn" type="button" @click="addFact">添加</button>
          </li>
        </template>
        <template v-else>
          <li v-for="fact in store.stateBoard.facts" :key="fact" class="bv-board__fact">
            {{ fact }}
          </li>
        </template>
      </ul>
      <p v-else class="bv-board__hint">暂无事实。</p>

      <h3 class="bv-board__section">调查员（{{ pcEntries.length }}）</h3>
      <p v-if="pcEntries.length === 0" class="bv-board__hint">还没有 PC——在「卡库」标签声明。</p>
      <div v-for="[id, pc] in pcEntries" :key="id" class="bv-board__pc">
        <div class="bv-board__pc-head">
          <span class="bv-board__pc-name">{{ pc.sheet.playerName }}</span>
          <span class="bv-board__pc-job">{{ pc.sheet.occupation }}</span>
        </div>
        <div class="bv-board__pc-stats">
          <template v-if="draft.active && draft.pcs[id]">
            <label class="bv-board__stat"
              >SAN <input v-model="draft.pcs[id]!.san" class="bv-board__num" type="number"
            /></label>
            <label class="bv-board__stat"
              >HP <input v-model="draft.pcs[id]!.hp" class="bv-board__num" type="number"
            /></label>
            <label class="bv-board__stat"
              >MP <input v-model="draft.pcs[id]!.mp" class="bv-board__num" type="number"
            /></label>
          </template>
          <template v-else>
            <span class="bv-board__stat">SAN {{ pc.sheet.san }}</span>
            <span class="bv-board__stat">HP {{ pc.sheet.hp }}</span>
            <span class="bv-board__stat">MP {{ pc.sheet.mp }}</span>
            <span class="bv-board__stat">幸运 {{ pc.sheet.luck }}</span>
          </template>
          <span
            v-for="cond in pc.conditions"
            :key="cond"
            class="bv-board__condition"
            :class="{ 'bv-board__condition--bad': cond.includes('重伤') || cond.includes('疯狂') }"
          >
            {{ cond }}
          </span>
        </div>
        <div v-if="draft.active && draft.pcs[id]" class="bv-board__edit-row">
          <input
            :value="draft.pcs[id]!.conditions.join('，')"
            class="bv-board__input"
            placeholder="状态（逗号分隔，如 疯狂(临时)，重伤）"
            @input="
              draft.pcs[id]!.conditions = ($event.target as HTMLInputElement).value
                .split(/[，,、]/)
                .map((c) => c.trim())
                .filter((c) => c !== '')
            "
          />
        </div>
      </div>

      <div v-if="editable" class="bv-board__actions">
        <template v-if="!draft.active">
          <button class="bv-board__btn" @click="beginEdit">编辑状态板</button>
        </template>
        <template v-else>
          <button class="bv-board__btn" @click="save">
            保存（v{{ store.stateBoard.version }}）
          </button>
          <button class="bv-board__btn bv-board__btn--ghost" @click="cancelEdit">取消</button>
        </template>
      </div>
    </template>
  </section>
</template>

<style scoped>
.bv-board {
  display: flex;
  flex-direction: column;
  gap: var(--bv-space-2);
  font-size: 13px;
}
.bv-board__head {
  display: flex;
  align-items: center;
  gap: var(--bv-space-2);
}
.bv-board__title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.bv-board__version {
  color: var(--bv-text-tertiary);
  font-size: 11px;
}
.bv-board__head .bv-board__btn {
  margin-left: auto;
}
.bv-board__section {
  margin: var(--bv-space-2) 0 0;
  font-size: 12px;
  color: var(--bv-text-tertiary);
  letter-spacing: 0.1em;
}
.bv-board__scene {
  margin: 0;
}
.bv-board__desc {
  margin: 0;
  color: var(--bv-text-secondary);
}
.bv-board__facts {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--bv-space-1);
}
.bv-board__fact {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--bv-space-2);
  color: var(--bv-text-secondary);
}
.bv-board__pc {
  padding: var(--bv-space-2);
  border: 1px solid var(--bv-line-subtle);
  border-radius: var(--bv-radius-card);
  background: var(--bv-bg-elevated);
  display: flex;
  flex-direction: column;
  gap: var(--bv-space-1);
}
.bv-board__pc-head {
  display: flex;
  justify-content: space-between;
  gap: var(--bv-space-2);
}
.bv-board__pc-name {
  font-weight: 600;
}
.bv-board__pc-job {
  color: var(--bv-text-tertiary);
}
.bv-board__pc-stats {
  display: flex;
  flex-wrap: wrap;
  gap: var(--bv-space-2);
  color: var(--bv-text-secondary);
  font-size: 12px;
}
.bv-board__condition {
  padding: 0 var(--bv-space-2);
  border: 1px solid var(--bv-line-subtle);
  border-radius: var(--bv-radius-card);
  font-size: 11px;
}
.bv-board__condition--bad {
  border-color: var(--bv-judge-fail);
  color: var(--bv-judge-fail);
}
.bv-board__actions {
  display: flex;
  gap: var(--bv-space-2);
  margin-top: var(--bv-space-2);
}
.bv-board__btn {
  padding: var(--bv-space-1) var(--bv-space-3);
  border: none;
  border-radius: var(--bv-radius-card);
  background: var(--bv-accent);
  color: var(--bv-bg-canvas);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.bv-board__btn--ghost {
  background: transparent;
  border: 1px solid var(--bv-line-subtle);
  color: var(--bv-text-secondary);
}
.bv-board__input,
.bv-board__textarea {
  padding: var(--bv-space-1) var(--bv-space-2);
  border: 1px solid var(--bv-line-subtle);
  border-radius: var(--bv-radius-card);
  background: var(--bv-bg-elevated);
  color: var(--bv-text-primary);
  font: inherit;
  font-size: 12px;
  min-width: 0;
}
.bv-board__edit-row {
  display: flex;
  gap: var(--bv-space-2);
}
.bv-board__num {
  width: 64px;
  padding: 0 var(--bv-space-1);
  border: 1px solid var(--bv-line-subtle);
  border-radius: var(--bv-radius-card);
  background: var(--bv-bg-canvas);
  color: var(--bv-text-primary);
  font: inherit;
  font-size: 12px;
}
.bv-board__hint {
  margin: 0;
  color: var(--bv-text-tertiary);
  font-size: 12px;
}
</style>
