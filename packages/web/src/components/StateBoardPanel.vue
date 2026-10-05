<script setup lang="ts">
import { computed, reactive, watch } from 'vue';
import { useSessionStore } from '../stores/session';
import { conditionText } from '@behindveil/shared';
import type {
  Coc7Sheet,
  Condition,
  Dnd5eAbility,
  Initiative,
  PCSheet,
  Resource,
  ResourceResetOn,
  StateBoardPc,
  StatePatch,
} from '@behindveil/shared';

/**
 * 状态板面板（T-M5-10 / T-M8-07，FR-09/24）：全房可见的场景/事实/PC 状态展示；
 * Host 可编辑（scene/facts/PC 数值与状态，走 state:update 乐观锁）并生成快照。
 * 冲突（E-ST-01）时服务端会广播最新版，本地自动对齐——错误横幅提示重试即可。
 * PC 数值渲染与编辑按 sheet.rulebook 分流：COC 是 SAN/HP/MP，5e 是 HP 条 + AC + 六维。
 */

const store = useSessionStore();

const editable = computed(() => store.role === 'host' && store.stateBoard !== null);

/** Host 编辑草稿按规则书分型：两套卡的数值面不同，保存时各自并回 sheet */
type PcDraft =
  | {
      rulebook: 'coc7';
      san: number;
      hp: number;
      mp: number;
      conditions: Condition[];
      resources: Resource[];
    }
  | {
      rulebook: 'dnd5e';
      hpCurrent: number;
      hpMax: number;
      conditions: Condition[];
      resources: Resource[];
    };

/** 本地编辑草稿：进入编辑时深拷贝当前板，保存时整体作为 patch 提交 */
const draft = reactive<{
  active: boolean;
  scene: { name: string; time: string; publicDesc: string; initiative: Initiative | null };
  facts: string[];
  newFact: string;
  pcs: Record<string, PcDraft>;
}>({
  active: false,
  scene: { name: '', time: '', publicDesc: '', initiative: null },
  facts: [],
  newFact: '',
  pcs: {},
});

watch(
  () => store.stateBoard,
  (board) => {
    if (!board || !draft.active) return;
    // 广播到达（自己保存成功 / 他人冲突对齐）时刷新草稿底稿，但保留未保存的输入
    draft.scene = { ...board.scene, initiative: cloneInitiative(board.scene.initiative) };
    draft.facts = [...board.facts];
    for (const [id, pc] of Object.entries(board.pcs)) {
      if (draft.pcs[id]) continue; // 编辑中不覆盖已展开的行
      draft.pcs[id] = pickEditable(pc);
    }
  },
);

function pickEditable(pc: StateBoardPc): PcDraft {
  // 状态条目是对象（v3 FR-39）：逐条浅拷贝，避免草稿与原板共用引用
  const conditions = pc.conditions.map((c) => ({ ...c }));
  if (pc.sheet.rulebook === 'dnd5e') {
    return {
      rulebook: 'dnd5e',
      hpCurrent: pc.sheet.hp.current,
      hpMax: pc.sheet.hp.max,
      conditions,
      resources: pc.resources.map((r) => ({ ...r })),
    };
  }
  return {
    rulebook: 'coc7',
    san: pc.sheet.san,
    hp: pc.sheet.hp,
    mp: pc.sheet.mp,
    conditions,
    resources: pc.resources.map((r) => ({ ...r })),
  };
}

function beginEdit(): void {
  const board = store.stateBoard;
  if (!board) return;
  draft.active = true;
  draft.scene = { ...board.scene, initiative: cloneInitiative(board.scene.initiative) };
  draft.facts = [...board.facts];
  draft.pcs = Object.fromEntries(
    Object.entries(board.pcs).map(([id, pc]) => [id, pickEditable(pc)]),
  );
}

function cancelEdit(): void {
  draft.active = false;
}

/** 先攻看板（T-M12-03，FR-37）：全部操作都是 Host 手动点，无任何自动推进 */
function cloneInitiative(source: Initiative | null | undefined): Initiative | null {
  return source ? { ...source, order: source.order.map((e) => ({ ...e })) } : null;
}

function initiativeDraft(): Initiative | null {
  return draft.scene.initiative;
}

function ensureInitiative(): Initiative {
  if (!draft.scene.initiative) {
    draft.scene.initiative = { order: [], currentIdx: 0, round: 1 };
  }
  return draft.scene.initiative;
}

function addInitiativeEntry(): void {
  ensureInitiative().order.push({ ref: `npc:${Date.now()}`, label: '', roll: 0 });
}

function removeInitiativeEntry(index: number): void {
  const init = initiativeDraft();
  if (!init) return;
  init.order.splice(index, 1);
  if (init.currentIdx >= init.order.length) init.currentIdx = 0;
}

/** 按先攻值降序重排（录入顺序不必有序，排序是展示口径） */
function sortInitiative(): void {
  const init = initiativeDraft();
  if (!init) return;
  init.order.sort((a, b) => b.roll - a.roll);
  init.currentIdx = 0;
}

function stepInitiative(delta: number): void {
  const init = initiativeDraft();
  if (!init || init.order.length === 0) return;
  const next = init.currentIdx + delta;
  if (next >= init.order.length) {
    init.currentIdx = 0;
    init.round += 1;
  } else if (next < 0) {
    init.currentIdx = init.order.length - 1;
    if (init.round > 1) init.round -= 1;
  } else {
    init.currentIdx = next;
  }
}

function setInitiativeField<K extends 'label' | 'roll'>(
  index: number,
  field: K,
  value: string,
): void {
  const entry = initiativeDraft()?.order[index];
  if (!entry) return;
  if (field === 'label') entry.label = value;
  else {
    const parsed = Number(value);
    entry.roll = Number.isFinite(parsed) ? parsed : 0;
  }
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

/** 状态条目编辑（FR-39）：标签必填，说明与到期提示选填——到期只是给人看的提示，不做自动解除 */
function addCondition(memberId: string): void {
  draft.pcs[memberId]?.conditions.push({ label: '' });
}

function removeCondition(memberId: string, index: number): void {
  draft.pcs[memberId]?.conditions.splice(index, 1);
}

function addResource(memberId: string): void {
  draft.pcs[memberId]?.resources.push({ name: '', current: 0, max: 0, resetOn: 'none' });
}

function removeResource(memberId: string, index: number): void {
  draft.pcs[memberId]?.resources.splice(index, 1);
}

function setResourceNumber(
  memberId: string,
  index: number,
  field: 'current' | 'max',
  value: string,
): void {
  const res = draft.pcs[memberId]?.resources[index];
  if (!res) return;
  const parsed = Number(value);
  res[field] = Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

function setResourceMeta(
  memberId: string,
  index: number,
  field: 'name' | 'resetOn',
  value: string,
): void {
  const res = draft.pcs[memberId]?.resources[index];
  if (!res) return;
  if (field === 'name') res.name = value;
  else res.resetOn = value as ResourceResetOn;
}

function setConditionField<K extends 'label' | 'note' | 'expiresHint'>(
  memberId: string,
  index: number,
  field: K,
  value: string,
): void {
  const cond = draft.pcs[memberId]?.conditions[index];
  if (!cond) return;
  if (value === '') delete cond[field];
  else cond[field] = value;
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
        const sheet: PCSheet = edited ? mergeEditable(pc.sheet, edited) : pc.sheet;
        return [
          id,
          {
            sheet,
            conditions: edited
              ? edited.conditions.filter((c) => c.label.trim() !== '')
              : pc.conditions,
            resources: edited ? edited.resources.filter((r) => r.name.trim() !== '') : pc.resources,
          },
        ];
      }),
    ),
  };
  store.updateState(patch);
  draft.active = false;
}

/** 编辑值并回 sheet：只覆盖该规则书自己的数值面（草稿与卡同型，分支保证不串） */
function mergeEditable(sheet: PCSheet, edited: PcDraft): PCSheet {
  if (sheet.rulebook === 'dnd5e' && edited.rulebook === 'dnd5e') {
    return {
      ...sheet,
      hp: { max: num(edited.hpMax), current: num(edited.hpCurrent) },
    };
  }
  if (sheet.rulebook === 'coc7' && edited.rulebook === 'coc7') {
    const coc: Coc7Sheet = {
      ...sheet,
      san: num(edited.san),
      hp: num(edited.hp),
      mp: num(edited.mp),
    };
    return coc;
  }
  return sheet; // 广播把卡换成了另一套规则书且本行还在编辑——放弃本行数值编辑
}

function num(value: number | string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

const pcEntries = computed(() => Object.entries(store.stateBoard?.pcs ?? {}));

// ---- 5e 渲染（T-M8-07）----

const ABILITY_ZH: Record<Dnd5eAbility, string> = {
  str: '力量',
  dex: '敏捷',
  con: '体质',
  int: '智力',
  wis: '感知',
  cha: '魅力',
};

function abilityEntries(sheet: Extract<PCSheet, { rulebook: 'dnd5e' }>): {
  key: Dnd5eAbility;
  label: string;
  score: number;
  proficient: boolean;
}[] {
  return (Object.keys(sheet.abilities) as Dnd5eAbility[]).map((key) => ({
    key,
    label: ABILITY_ZH[key],
    score: sheet.abilities[key],
    proficient: sheet.proficientSaves.includes(key),
  }));
}

function hpPercent(current: number, max: number): number {
  if (max <= 0) return 0;
  return Math.min(100, Math.max(0, (current / max) * 100));
}
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

      <!-- 先攻看板（T-M12-03，FR-37）：只读展示 + Host 手动维护 -->
      <template v-if="store.stateBoard.scene.initiative">
        <h3 class="bv-board__section">
          先攻
          <span class="bv-board__round">R{{ store.stateBoard.scene.initiative.round }}</span>
        </h3>
        <ol class="bv-board__initiative">
          <li
            v-for="(entry, i) in store.stateBoard.scene.initiative.order"
            :key="entry.ref"
            class="bv-board__init-entry"
            :class="{
              'bv-board__init-entry--current': i === store.stateBoard.scene.initiative.currentIdx,
            }"
          >
            <span class="bv-board__init-roll">{{ entry.roll }}</span>
            <span class="bv-board__init-label">{{ entry.label }}</span>
          </li>
        </ol>
      </template>
      <template v-if="draft.active">
        <div class="bv-board__cond-edit">
          <div class="bv-board__init-actions">
            <button class="bv-board__btn bv-board__btn--ghost" @click="ensureInitiative">
              {{ draft.scene.initiative ? '编辑先攻' : '新建先攻' }}
            </button>
            <template v-if="draft.scene.initiative">
              <button class="bv-board__btn bv-board__btn--ghost" @click="addInitiativeEntry">
                + 条目
              </button>
              <button class="bv-board__btn bv-board__btn--ghost" @click="sortInitiative">
                按值排序
              </button>
              <button class="bv-board__btn bv-board__btn--ghost" @click="stepInitiative(-1)">
                ← 上一个
              </button>
              <button class="bv-board__btn bv-board__btn--ghost" @click="stepInitiative(1)">
                下一个 →
              </button>
              <button
                class="bv-board__btn bv-board__btn--ghost"
                @click="draft.scene.initiative = null"
              >
                清除
              </button>
            </template>
          </div>
          <div
            v-for="(entry, i) in draft.scene.initiative?.order ?? []"
            :key="i"
            class="bv-board__cond-row"
          >
            <span class="bv-board__init-idx">{{
              i === draft.scene.initiative?.currentIdx ? '▸' : ''
            }}</span>
            <input
              :value="entry.label"
              class="bv-board__input bv-board__input--cond"
              placeholder="名字（如 哥布林）"
              @input="setInitiativeField(i, 'label', ($event.target as HTMLInputElement).value)"
            />
            <input
              :value="String(entry.roll)"
              class="bv-board__input bv-board__num"
              title="先攻值"
              @input="setInitiativeField(i, 'roll', ($event.target as HTMLInputElement).value)"
            />
            <button
              class="bv-board__btn bv-board__btn--ghost"
              title="移除"
              @click="removeInitiativeEntry(i)"
            >
              ×
            </button>
          </div>
        </div>
      </template>

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

      <h3 class="bv-board__section">PC（{{ pcEntries.length }}）</h3>
      <p v-if="pcEntries.length === 0" class="bv-board__hint">还没有 PC——在「卡库」标签声明。</p>
      <div v-for="[id, pc] in pcEntries" :key="id" class="bv-board__pc">
        <div class="bv-board__pc-head">
          <span class="bv-board__pc-name">{{ pc.sheet.playerName }}</span>
          <span class="bv-board__pc-job">{{ pc.sheet.occupation }}</span>
          <span class="bv-board__pc-system">{{
            pc.sheet.rulebook === 'dnd5e' ? 'D&D 5e' : 'COC7'
          }}</span>
        </div>

        <!-- COC7：数值面与 v1 一致（渲染不回归） -->
        <div v-if="pc.sheet.rulebook === 'coc7'" class="bv-board__pc-stats">
          <template v-if="draft.active && draft.pcs[id]?.rulebook === 'coc7'">
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
        </div>

        <!-- 5e：HP 条（current/max）+ AC + 六维（豁免熟练标记） -->
        <div v-else class="bv-board__pc-stats">
          <template v-if="draft.active && draft.pcs[id]?.rulebook === 'dnd5e'">
            <label class="bv-board__stat"
              >HP
              <input v-model="draft.pcs[id]!.hpCurrent" class="bv-board__num" type="number" />
              /
              <input v-model="draft.pcs[id]!.hpMax" class="bv-board__num" type="number"
            /></label>
          </template>
          <template v-else>
            <span class="bv-board__hp">
              <span class="bv-board__hp-bar">
                <span
                  class="bv-board__hp-fill"
                  :style="{ width: hpPercent(pc.sheet.hp.current, pc.sheet.hp.max) + '%' }"
                ></span>
              </span>
              <span class="bv-board__stat">HP {{ pc.sheet.hp.current }}/{{ pc.sheet.hp.max }}</span>
            </span>
            <span class="bv-board__stat">AC {{ pc.sheet.ac }}</span>
          </template>
          <span class="bv-board__abilities">
            <span
              v-for="ab in abilityEntries(pc.sheet)"
              :key="ab.key"
              class="bv-board__ability"
              :class="{ 'bv-board__ability--prof': ab.proficient }"
              :title="ab.proficient ? '豁免熟练' : ''"
            >
              {{ ab.label }} {{ ab.score }}
            </span>
          </span>
        </div>

        <div class="bv-board__pc-stats">
          <span
            v-for="(cond, ci) in pc.conditions"
            :key="ci"
            class="bv-board__condition"
            :class="{
              'bv-board__condition--bad':
                cond.label.includes('重伤') || cond.label.includes('疯狂'),
            }"
            :title="
              cond.expiresHint
                ? `${conditionText(cond)}｜到期：${cond.expiresHint}`
                : conditionText(cond)
            "
          >
            {{ conditionText(cond) }}
          </span>
        </div>
        <div v-if="draft.active && draft.pcs[id]" class="bv-board__cond-edit">
          <div v-for="(cond, ci) in draft.pcs[id]!.conditions" :key="ci" class="bv-board__cond-row">
            <input
              :value="cond.label"
              class="bv-board__input bv-board__input--cond"
              placeholder="状态名（如 重伤）"
              @input="setConditionField(id, ci, 'label', ($event.target as HTMLInputElement).value)"
            />
            <input
              :value="cond.note ?? ''"
              class="bv-board__input bv-board__input--cond"
              placeholder="说明（选填）"
              @input="setConditionField(id, ci, 'note', ($event.target as HTMLInputElement).value)"
            />
            <input
              :value="cond.expiresHint ?? ''"
              class="bv-board__input bv-board__input--cond"
              placeholder="到期（选填）"
              @input="
                setConditionField(id, ci, 'expiresHint', ($event.target as HTMLInputElement).value)
              "
            />
            <button
              class="bv-board__btn bv-board__btn--ghost"
              title="移除该状态"
              @click="removeCondition(id, ci)"
            >
              ×
            </button>
          </div>
          <button class="bv-board__btn bv-board__btn--ghost" @click="addCondition(id)">
            + 状态
          </button>
        </div>

        <div v-if="pc.resources.length > 0" class="bv-board__pc-resources">
          <span v-for="res in pc.resources" :key="res.name" class="bv-board__resource">
            {{ res.name }} {{ res.current }}/{{ res.max }}
          </span>
        </div>
        <div v-if="draft.active && draft.pcs[id]" class="bv-board__cond-edit">
          <div v-for="(res, ri) in draft.pcs[id]!.resources" :key="ri" class="bv-board__cond-row">
            <input
              :value="res.name"
              class="bv-board__input bv-board__input--cond"
              placeholder="资源名（如 一环法术位）"
              @input="setResourceMeta(id, ri, 'name', ($event.target as HTMLInputElement).value)"
            />
            <input
              :value="String(res.current)"
              class="bv-board__input bv-board__num"
              title="当前值"
              @input="
                setResourceNumber(id, ri, 'current', ($event.target as HTMLInputElement).value)
              "
            />
            <input
              :value="String(res.max)"
              class="bv-board__input bv-board__num"
              title="上限"
              @input="setResourceNumber(id, ri, 'max', ($event.target as HTMLInputElement).value)"
            />
            <select
              :value="res.resetOn"
              class="bv-board__input"
              title="重置时机（仅标签，服务端不自动重置）"
              @change="
                setResourceMeta(id, ri, 'resetOn', ($event.target as HTMLSelectElement).value)
              "
            >
              <option value="none">不重置</option>
              <option value="short_rest">短休</option>
              <option value="long_rest">长休</option>
            </select>
            <button
              class="bv-board__btn bv-board__btn--ghost"
              title="移除该资源"
              @click="removeResource(id, ri)"
            >
              ×
            </button>
          </div>
          <button class="bv-board__btn bv-board__btn--ghost" @click="addResource(id)">
            + 资源
          </button>
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
.bv-board__pc-system {
  margin-left: auto;
  padding: 0 var(--bv-space-1);
  border: 1px solid var(--bv-line-subtle);
  border-radius: var(--bv-radius-card);
  font-size: 10px;
  color: var(--bv-text-tertiary);
}
.bv-board__pc-stats {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--bv-space-2);
  color: var(--bv-text-secondary);
  font-size: 12px;
}
.bv-board__hp {
  display: flex;
  align-items: center;
  gap: var(--bv-space-1);
}
.bv-board__hp-bar {
  width: 72px;
  height: 6px;
  border: 1px solid var(--bv-line-subtle);
  border-radius: 3px;
  overflow: hidden;
  background: var(--bv-bg-canvas);
}
.bv-board__hp-fill {
  display: block;
  height: 100%;
  background: var(--bv-accent);
}
.bv-board__abilities {
  display: flex;
  flex-wrap: wrap;
  gap: var(--bv-space-1);
}
.bv-board__ability {
  padding: 0 var(--bv-space-1);
  border: 1px solid var(--bv-line-subtle);
  border-radius: var(--bv-radius-card);
  font-size: 11px;
}
.bv-board__ability--prof {
  border-color: var(--bv-accent);
  color: var(--bv-accent);
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
/* 状态条目编辑区（FR-39）：每条目一行三字段，独占竖排 */
.bv-board__cond-edit {
  display: flex;
  flex-direction: column;
  gap: var(--bv-space-1);
}
.bv-board__cond-row {
  display: flex;
  align-items: center;
  gap: var(--bv-space-1);
}
.bv-board__initiative {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.bv-board__init-entry {
  display: flex;
  align-items: baseline;
  gap: var(--bv-space-2);
  padding: 1px var(--bv-space-1);
  border-radius: var(--bv-radius-card);
  font-size: 12px;
  color: var(--bv-text-secondary);
}
.bv-board__init-entry--current {
  background: var(--bv-bg-elevated);
  color: var(--bv-text-primary);
}
.bv-board__init-roll {
  min-width: 24px;
  text-align: right;
  font-family: var(--bv-font-mono, monospace);
}
.bv-board__init-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--bv-space-1);
}
.bv-board__init-idx {
  min-width: 12px;
  color: var(--bv-accent, #c79640);
}
.bv-board__round {
  color: var(--bv-text-tertiary);
  font-size: 12px;
}
.bv-board__pc-resources {
  display: flex;
  flex-wrap: wrap;
  gap: var(--bv-space-1);
  margin-top: var(--bv-space-1);
}
.bv-board__resource {
  padding: 0 var(--bv-space-1);
  border: 1px solid var(--bv-line-subtle);
  border-radius: var(--bv-radius-card);
  background: var(--bv-bg-elevated);
  color: var(--bv-text-secondary);
  font-size: 12px;
}
.bv-board__input--cond:first-child {
  flex: 1 1 auto;
}
.bv-board__input--cond {
  flex: 1 1 0;
  min-width: 64px;
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
