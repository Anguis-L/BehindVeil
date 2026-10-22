<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useSessionStore } from '../stores/session';
import LlmSettingsPanel from './LlmSettingsPanel.vue';

/**
 * 开局准备（2026-10-09 可用性改造）：把「选剧本 + 分配角色 + 开团」压进**一屏**，
 * 且直接放在房间主区——不再藏进右栏标签、不再有三级表单。
 *
 * 交互约定（务必保持不变，这三条是本组件的立身之本）：
 * 1. **角色是点出来的，不是选出来的**：可分配角色渲染成一排可点的角色块，
 *    点一下即选中并**当场落库**（PUT /rooms/:id/pcs/:memberId），再点一下取消。
 *    没有「确认」按钮、没有二次弹窗——选中态本身就是反馈。
 * 2. **选中态可见**：已选中的角色块带金色描边与 ● 标记；成员行右侧即时显示当前角色名。
 * 3. **没有卡也能开局**：卡库为空时，每位成员旁边都能直接「新建角色」（只填名字，
 *    规则书默认跟着剧本走），不强制先导入 PNG 卡。
 * 开团后本组件整体让位给消息流（由 RoomPage 决定是否渲染）。
 */

const store = useSessionStore();

// ---- AI 就绪状态（迭代 2）：AI 没接好就开团，KP 会沉默而用户不知道为什么 ----
const showLlm = ref(false);
/** null = 拿不到状态（这台服务器设了管理令牌且未填）：不显示状态条，静默降级 */
const llmState = computed(() => store.llm);
/** 就绪但没密钥：真实调用会 401，与「未配置」同样致命 */
const llmWarn = computed(() => {
  const llm = store.llm;
  if (!llm) return null;
  if (!llm.ready) return 'AI 还没接好——现在开团，KP 不会说话';
  if (!llm.hasApiKey && llm.provider !== 'ollama' && llm.provider !== 'mock')
    return 'AI 缺少密钥——开团后第一次对话就会被拒绝';
  return null;
});

const moduleId = ref('');
const modulesLoaded = ref(false);
const starting = ref(false);

// 迭代 8：分配请求在途时锁住这一行的角色块，防连点造成重复声明
const busyMember = ref<string | null>(null);

// 「新建角色」是内联展开的一行，不是弹窗（用户明确要求去掉确认弹窗）
const newFor = ref<string | null>(null);
const newName = ref('');
const newRulebook = ref<'coc7' | 'dnd5e'>('dnd5e');

const RULEBOOK_LABEL: Record<string, string> = {
  coc7: '克苏鲁 7 版',
  dnd5e: '龙与地下城 5e',
  generic: '通用规则',
};

function rulebookLabel(id: string): string {
  return RULEBOOK_LABEL[id] ?? id;
}

const isHost = computed(() => store.role === 'host');
/** 可分配的角色：卡库里的玩家卡（KP 卡不能当 PC） */
const pcCards = computed(() => store.cards.filter((c) => c.kind === 'pc'));
/** 参与游戏的成员：Host 与玩家；旁观者不分配角色 */
const seats = computed(() => store.members.filter((m) => m.role !== 'observer'));

const selectedModule = computed(() => store.modules.find((m) => m.id === moduleId.value));
/** 剧本不定规则书时，新建角色的规则书默认跟着剧本走（少一步选择） */
const defaultRulebook = computed<'coc7' | 'dnd5e'>(() =>
  selectedModule.value?.rulebook === 'coc7' ? 'coc7' : 'dnd5e',
);

function assigned(memberId: string) {
  return store.roster.find((r) => r.memberId === memberId);
}

function assignedLabel(memberId: string): string {
  const entry = assigned(memberId);
  if (!entry) return '未分配';
  return entry.sheet?.playerName || entry.sheet?.occupation || '已分配';
}

function assignedCardId(memberId: string): string | undefined {
  return assigned(memberId)?.cardId;
}

const unassignedCount = computed(() => seats.value.filter((m) => !assigned(m.id)).length);

async function ensureModules(): Promise<void> {
  if (modulesLoaded.value) return;
  modulesLoaded.value = true;
  await store.loadModules();
  if (!moduleId.value && store.modules.length > 0) moduleId.value = store.modules[0]!.id;
}

async function installSamples(): Promise<void> {
  await store.installSampleModules();
  modulesLoaded.value = false;
  await ensureModules();
}

/** 点角色块：选中 / 再点取消，都即时生效 */
async function pickCard(memberId: string, cardId: string): Promise<void> {
  if (!isHost.value || busyMember.value === memberId) return;
  busyMember.value = memberId;
  try {
    if (assignedCardId(memberId) === cardId) await store.undeclarePc(memberId);
    else await store.assignPc(memberId, cardId);
  } finally {
    busyMember.value = null;
  }
}

function openNewPc(memberId: string): void {
  if (!isHost.value) return;
  newFor.value = newFor.value === memberId ? null : memberId;
  newName.value = '';
  newRulebook.value = defaultRulebook.value;
}

async function createPc(memberId: string): Promise<void> {
  if (newName.value.trim() === '') return;
  const ok = await store.assignBlankPc(memberId, newName.value, newRulebook.value);
  if (ok) {
    newFor.value = null;
    newName.value = '';
  }
}

async function start(): Promise<void> {
  if (!moduleId.value || starting.value) return;
  starting.value = true;
  try {
    await store.startSession(moduleId.value);
  } finally {
    starting.value = false;
  }
}

onMounted(() => {
  void ensureModules();
  void store.loadSetupData();
  void store.loadLlmConfig().catch(() => undefined); // 拿不到就静默（服务器设了令牌且未填）
});

// 成员进出房会变（room:sync），名册要跟着刷新；令牌变了也要重拉（免令牌/需令牌两种情况）
watch(
  () => store.members.length,
  () => void store.loadSetupData(),
);
watch(
  () => store.adminToken,
  () => void store.loadSetupData(),
);
</script>

<template>
  <section class="bv-setup">
    <header class="bv-setup__head">
      <h2 class="bv-setup__title">开局准备</h2>
      <p class="bv-setup__lead">
        选好剧本、给每人点一个角色，就可以开始。角色随时能改，开团后也能换。
      </p>

      <!-- 迭代 2：AI 就绪状态条——开团前最后一道检查 -->
      <div v-if="llmWarn" class="bv-setup__ai bv-setup__ai--warn" role="status">
        <span>⚠ {{ llmWarn }}</span>
        <button class="bv-setup__link" type="button" @click="showLlm = true">去接 AI →</button>
      </div>
      <p v-else-if="llmState?.ready" class="bv-setup__ai bv-setup__ai--ok">
        ● AI 已就绪 · {{ llmState.model || llmState.adapterId }}
      </p>
    </header>

    <!-- ① 剧本：一级可见，不再是手填 ID -->
    <div class="bv-setup__block">
      <label class="bv-setup__label">这一场跑什么（剧本）</label>
      <div class="bv-setup__row">
        <select v-model="moduleId" class="bv-setup__select" aria-label="选择剧本">
          <option v-if="store.modules.length === 0" value="">（还没有剧本）</option>
          <option v-for="mod in store.modules" :key="mod.id" :value="mod.id">
            {{ mod.name }} · {{ rulebookLabel(mod.rulebook) }}
          </option>
        </select>
      </div>
      <p v-if="store.modules.length === 0" class="bv-setup__hint">
        剧本 = 这一场的设定、KP 人设与开局，开团必须有。
        <button
          v-if="store.samplesAvailable"
          class="bv-setup__btn bv-setup__btn--primary bv-setup__btn--sm"
          type="button"
          @click="installSamples"
        >
          一键装载内置示例剧本
        </button>
        <template v-else>把模组文件夹放到服务端 data/modules/ 下再刷新。</template>
      </p>
      <p v-else-if="selectedModule" class="bv-setup__hint">
        {{ rulebookLabel(selectedModule.rulebook) }} · 新建角色默认用这套规则
      </p>
    </div>

    <!-- ② 角色：点一下即选中，选中态就是反馈 -->
    <div class="bv-setup__block">
      <label class="bv-setup__label">
        谁演哪个角色
        <span class="bv-setup__count"
          >（{{ seats.length - unassignedCount }}/{{ seats.length }} 已分配）</span
        >
      </label>

      <ul class="bv-setup__seats">
        <li
          v-for="member in seats"
          :key="member.id"
          class="bv-setup__seat"
          :class="{ 'is-me': member.id === store.memberId }"
        >
          <div class="bv-setup__seat-head">
            <span class="bv-setup__name">{{ member.name }}</span>
            <span v-if="member.id === store.memberId" class="bv-setup__tag bv-setup__tag--you"
              >你</span
            >
            <span v-if="member.role === 'host'" class="bv-setup__tag">房主</span>
            <span class="bv-setup__role" :class="{ 'is-set': !!assigned(member.id) }">
              {{ assignedLabel(member.id) }}
            </span>
            <button
              v-if="isHost && assigned(member.id)"
              class="bv-setup__link"
              type="button"
              @click="store.undeclarePc(member.id)"
            >
              清除
            </button>
          </div>

          <div v-if="isHost" class="bv-setup__chips">
            <button
              v-for="card in pcCards"
              :key="card.id"
              class="bv-setup__chip"
              :class="{ 'is-picked': assignedCardId(member.id) === card.id }"
              type="button"
              :disabled="busyMember === member.id"
              :title="assignedCardId(member.id) === card.id ? '再点一下取消' : '点一下选它'"
              @click="pickCard(member.id, card.id)"
            >
              <span v-if="assignedCardId(member.id) === card.id" class="bv-setup__dot">●</span>
              {{ card.name }}
            </button>

            <button
              class="bv-setup__chip bv-setup__chip--new"
              :class="{ 'is-open': newFor === member.id }"
              type="button"
              @click="openNewPc(member.id)"
            >
              ＋ 新建角色
            </button>

            <span
              v-if="pcCards.length === 0 && newFor !== member.id && !assigned(member.id)"
              class="bv-setup__hint"
            >
              卡库里还没有角色卡，点「新建角色」直接填个名字就能开
            </span>
          </div>

          <div v-if="newFor === member.id" class="bv-setup__new">
            <input
              v-model="newName"
              class="bv-setup__input"
              placeholder="角色名（如：艾拉·文特）"
              autocomplete="off"
              @keydown.enter="createPc(member.id)"
            />
            <select v-model="newRulebook" class="bv-setup__select bv-setup__select--sm">
              <option value="dnd5e">龙与地下城 5e</option>
              <option value="coc7">克苏鲁 7 版</option>
            </select>
            <button
              class="bv-setup__btn bv-setup__btn--ghost"
              type="button"
              :disabled="newName.trim() === ''"
              @click="createPc(member.id)"
            >
              建立
            </button>
          </div>
        </li>
      </ul>

      <p v-if="seats.length === 0" class="bv-setup__hint">还没有人进房，等朋友用邀请码进来。</p>
    </div>

    <!-- ③ 开始：只有这一步需要点，没有确认弹窗 -->
    <div class="bv-setup__start">
      <!-- 迭代 4：提示与按钮同行，按钮永远是最醒目的那个元素 -->
      <div class="bv-setup__start-row">
        <span v-if="isHost && unassignedCount > 0" class="bv-setup__hint">
          {{ unassignedCount }} 位还没角色——不影响开团，进去后随时能补
        </span>
        <span v-else-if="isHost" class="bv-setup__hint">都就绪了，随时可以开始</span>
        <button
          v-if="isHost"
          class="bv-setup__btn bv-setup__btn--primary"
          type="button"
          :disabled="!moduleId || starting"
          @click="start"
        >
          {{ starting ? '开始中…' : '开始游戏' }}
        </button>
      </div>
      <p v-if="!isHost" class="bv-setup__hint">等房主开团；你的角色由房主分配。</p>
      <p v-if="store.error" class="bv-setup__error">{{ store.error }}</p>
    </div>

    <LlmSettingsPanel v-if="showLlm" @close="showLlm = false" />
  </section>
</template>

<style scoped>
.bv-setup {
  display: flex;
  flex-direction: column;
  gap: var(--bv-space-5);
  padding: var(--bv-space-5);
  border: 1px solid var(--bv-line-subtle);
  border-radius: var(--bv-radius-card);
  background: var(--bv-bg-surface);
}
.bv-setup__head {
  display: flex;
  flex-direction: column;
  gap: var(--bv-space-2);
}
.bv-setup__title {
  margin: 0;
  font-size: 18px;
  letter-spacing: 0.06em;
}
.bv-setup__lead {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--bv-text-secondary);
}
.bv-setup__block {
  display: flex;
  flex-direction: column;
  gap: var(--bv-space-2);
}
.bv-setup__label {
  font-size: 12px;
  letter-spacing: 0.1em;
  color: var(--bv-text-tertiary);
}
.bv-setup__count {
  letter-spacing: 0;
  color: var(--bv-text-secondary);
}
.bv-setup__row {
  display: flex;
  gap: var(--bv-space-2);
}
.bv-setup__select {
  flex: 1;
  padding: var(--bv-space-3);
  border: 1px solid var(--bv-line-subtle);
  border-radius: var(--bv-radius-card);
  background: var(--bv-bg-elevated);
  color: var(--bv-text-primary);
  font: inherit;
}
.bv-setup__select--sm {
  flex: 0 0 auto;
  padding: var(--bv-space-2);
  font-size: 12px;
}
.bv-setup__input {
  flex: 1;
  padding: var(--bv-space-2) var(--bv-space-3);
  border: 1px solid var(--bv-line-subtle);
  border-radius: var(--bv-radius-card);
  background: var(--bv-bg-elevated);
  color: var(--bv-text-primary);
  font: inherit;
}
.bv-setup__seats {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--bv-space-3);
}
.bv-setup__seat {
  display: flex;
  flex-direction: column;
  gap: var(--bv-space-2);
  padding: var(--bv-space-3);
  border: 1px solid var(--bv-line-subtle);
  border-radius: var(--bv-radius-card);
  background: var(--bv-bg-elevated);
}
.bv-setup__seat-head {
  display: flex;
  align-items: center;
  gap: var(--bv-space-2);
  font-size: 13px;
}
.bv-setup__name {
  font-weight: 600;
  color: var(--bv-text-primary);
}
.bv-setup__tag {
  padding: 1px 6px;
  border-radius: var(--bv-radius-pill);
  background: var(--bv-bg-sunken);
  color: var(--bv-text-tertiary);
  font-size: 11px;
}
.bv-setup__role {
  margin-left: auto;
  color: var(--bv-text-tertiary);
  font-size: 12px;
}
.bv-setup__role.is-set {
  color: var(--bv-accent);
}
.bv-setup__chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--bv-space-2);
}
.bv-setup__chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: 1px solid var(--bv-line-subtle);
  border-radius: var(--bv-radius-pill);
  background: var(--bv-bg-surface);
  color: var(--bv-text-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition:
    border-color 0.15s,
    color 0.15s,
    background 0.15s;
}
.bv-setup__chip:hover {
  border-color: var(--bv-line-strong);
  color: var(--bv-text-primary);
}
/* 选中态：金色描边 + 圆点，不依赖颜色之外的通道也能看出来 */
.bv-setup__chip.is-picked {
  border-color: var(--bv-accent);
  background: var(--bv-bg-sunken);
  color: var(--bv-accent-lift);
  font-weight: 600;
}
.bv-setup__dot {
  font-size: 10px;
}
.bv-setup__chip--new {
  border-style: dashed;
}
.bv-setup__chip--new.is-open {
  border-style: solid;
  border-color: var(--bv-accent);
  color: var(--bv-accent);
}
.bv-setup__new {
  display: flex;
  gap: var(--bv-space-2);
}
.bv-setup__start {
  display: flex;
  flex-direction: column;
  gap: var(--bv-space-2);
}
/* 迭代 4：提示与主按钮同行；窄屏按钮占满整行 */
.bv-setup__start-row {
  display: flex;
  align-items: center;
  gap: var(--bv-space-3);
}
.bv-setup__start-row .bv-setup__hint {
  flex: 1;
}
.bv-setup__btn {
  padding: var(--bv-space-3) var(--bv-space-5);
  border: 1px solid var(--bv-line-subtle);
  border-radius: var(--bv-radius-card);
  background: var(--bv-bg-elevated);
  color: var(--bv-text-primary);
  font: inherit;
  cursor: pointer;
}
.bv-setup__btn--ghost {
  flex: 0 0 auto;
  padding: var(--bv-space-2) var(--bv-space-4);
  font-size: 12px;
}
.bv-setup__btn--primary {
  border: none;
  background: var(--bv-accent);
  color: var(--bv-bg-canvas);
  font-weight: 600;
  font-size: 15px;
}
.bv-setup__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.bv-setup__btn--sm {
  align-self: flex-start;
  padding: var(--bv-space-2) var(--bv-space-4);
  font-size: 13px;
}
/* 迭代 6：自己的座位一眼认出（描边 + 「你」标记，不靠颜色单独传意） */
.bv-setup__seat.is-me {
  border-color: var(--bv-line-strong);
}
.bv-setup__tag--you {
  color: var(--bv-accent-lift);
  background: var(--bv-bg-sunken);
}
/* 迭代 8：键盘可达（focus 可见）与在途态 */
.bv-setup__chip:focus-visible,
.bv-setup__btn:focus-visible,
.bv-setup__select:focus-visible,
.bv-setup__input:focus-visible {
  outline: 2px solid var(--bv-accent);
  outline-offset: 2px;
}
.bv-setup__chip:disabled {
  opacity: 0.6;
  cursor: wait;
}
.bv-setup__hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--bv-text-tertiary);
}
.bv-setup__link {
  border: none;
  background: transparent;
  padding: 0;
  color: var(--bv-accent);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.bv-setup__error {
  margin: 0;
  font-size: 12px;
  color: var(--bv-judge-fail);
}
@media (max-width: 600px) {
  .bv-setup__start-row {
    flex-direction: column-reverse;
    align-items: stretch;
  }
  .bv-setup__btn--primary {
    width: 100%;
  }
}
/* 迭代 2：AI 就绪状态条 */
.bv-setup__ai {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--bv-space-2);
  padding: var(--bv-space-2) var(--bv-space-3);
  border-radius: var(--bv-radius-card);
  font-size: 12px;
}
.bv-setup__ai--warn {
  border: 1px solid var(--bv-judge-hard);
  background: var(--bv-bg-sunken);
  color: var(--bv-judge-hard);
}
.bv-setup__ai--ok {
  color: var(--bv-judge-extreme);
  font-size: 12px;
}
</style>
