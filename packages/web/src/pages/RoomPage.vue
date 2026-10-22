<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue';
import { useSessionStore } from '../stores/session';
import { parseDiceInput } from '../dice-input.js';
import { diceKindLabel, diceNatBadge, diceTargetLabel } from '../dice-card.js';
import type { Message } from '@behindveil/shared';
import MessageCard from '../components/MessageCard.vue';
import KpConsole from '../components/KpConsole.vue';
import StateBoardPanel from '../components/StateBoardPanel.vue';
import CardImportPanel from '../components/CardImportPanel.vue';
import SetupPanel from '../components/SetupPanel.vue';
import WorldBookEditor from '../components/WorldBookEditor.vue';

const store = useSessionStore();
const draft = ref('');
const mode = ref<'ic' | 'ooc'>('ic');
const listEl = ref<HTMLElement | null>(null);

/** 右栏标签（角色选择已移到主区开局准备，这里只留房内工具面板） */
type RailTab = 'notes' | 'kp' | 'board' | 'cards' | 'worldbook';
const railTab = ref<RailTab>('board');
/** 世界书编辑器仅 Host 可见（读写房间世界书，与 KP 控制台同权限级别） */
const railTabs = computed<Array<{ key: RailTab; label: string }>>(() => [
  { key: 'board', label: '状态板' },
  { key: 'notes', label: '手记' },
  { key: 'kp', label: 'KP 控制台' },
  { key: 'cards', label: '角色卡' },
  ...(store.role === 'host' ? [{ key: 'worldbook' as const, label: '世界书' }] : []),
]);

/**
 * 窄屏抽屉（T-M6-07，NFR-01）。
 * 设计基线：「手机降为单栏 + 抽屉」——侧栏不能一藏了之，否则成员、角色卡、
 * KP 控制台在手机上等于没有。宽屏下这个状态不参与渲染（CSS 只在窄屏认它）。
 */
const drawer = ref<'left' | 'right' | null>(null);
function toggleDrawer(side: 'left' | 'right'): void {
  drawer.value = drawer.value === side ? null : side;
}

const canSend = computed(() => store.role !== 'observer' && store.activeSessionId !== null);

/** 迭代 10：离开房间——清座席回首页，下次进来是干净的身份（不会静默顶掉旧座） */
function leave(): void {
  store.leaveRoom();
}

/** 邀请码常驻顶部可复制（建房后不再停留结果页，这一步不能丢） */
const copied = ref(false);
async function copyInvite(): Promise<void> {
  try {
    await navigator.clipboard.writeText(store.inviteCode);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1600);
  } catch {
    copied.value = false;
  }
}

const ordered = computed(() => store.messages);

watch(
  // 流式叙事逐 delta 增长，内容变化也要跟随滚动（T-M3-08）
  () => [store.messages.length, store.streaming?.content] as const,
  async () => {
    await nextTick();
    listEl.value?.scrollTo({ top: listEl.value.scrollHeight });
  },
);

function send(): void {
  if (!draft.value.trim() || !canSend.value) return;
  // `.r` / `.rh` 走掷骰，其余按当前模式发言（T-M4-05）
  const parsed = parseDiceInput(draft.value);
  if (parsed.kind === 'dice') store.roll(parsed.expr, parsed.hidden);
  else store.send(mode.value, parsed.content);
  draft.value = '';
}

function judgeLabel(msg: Message): string | null {
  if (msg.type !== 'dice' || msg.hidden) return null;
  const check = msg.roll.check;
  if (!check) return null;
  if (check.outcome === 'critical') return '大成功';
  if (check.outcome === 'fumble') return '大失败';
  if (check.outcome === 'fail') return '失败';
  if (check.grade === 'extreme') return '极难成功';
  if (check.grade === 'hard') return '困难成功';
  return '普通成功';
}

function judgeClass(msg: Message): string {
  if (msg.type !== 'dice') return '';
  if (msg.hidden) return 'bv-judge-hidden';
  const check = msg.roll.check;
  if (!check) return 'bv-judge-regular';
  if (check.outcome === 'critical') return 'bv-judge-critical';
  if (check.outcome === 'fumble') return 'bv-judge-fumble';
  if (check.outcome === 'fail') return 'bv-judge-fail';
  if (check.grade === 'extreme') return 'bv-judge-extreme';
  if (check.grade === 'hard') return 'bv-judge-hard';
  return 'bv-judge-regular';
}

function senderName(msg: Message): string {
  if (msg.type === 'ic' || msg.type === 'ooc') {
    return store.memberNameMap.get(msg.senderId) ?? msg.senderId;
  }
  // 骰子：有 senderId 是玩家掷的，无则是引擎代掷（KP 检定）
  if (msg.type === 'dice') {
    return msg.senderId ? (store.memberNameMap.get(msg.senderId) ?? msg.senderId) : 'KP';
  }
  return '';
}
</script>

<template>
  <main class="bv-room">
    <header class="bv-room__topbar">
      <button
        class="bv-room__drawer-btn"
        type="button"
        aria-label="打开成员与模组面板"
        @click="toggleDrawer('left')"
      >
        ☰
      </button>
      <span class="bv-room__title">
        邀请码 <code class="bv-room__code">{{ store.inviteCode }}</code>
        <button class="bv-room__copy" type="button" @click="copyInvite">
          {{ copied ? '已复制' : '复制' }}
        </button>
        <span class="bv-room__me">· {{ store.name }}</span>
      </span>
      <span class="bv-room__session">
        {{ store.activeSessionId ? `会话 ${store.activeSessionId}` : '尚未开团' }}
      </span>
      <span v-if="store.connectionLost" class="bv-room__offline">连接已断开，正在重连…</span>
      <button
        class="bv-room__drawer-btn bv-room__drawer-btn--tail"
        type="button"
        aria-label="打开角色与控制台面板"
        @click="toggleDrawer('right')"
      >
        ⋯
      </button>
      <button class="bv-room__leave" type="button" @click="leave">离开</button>
    </header>

    <div class="bv-room__body">
      <aside
        class="bv-room__rail bv-room__rail--left"
        :class="{ 'bv-room__rail--open': drawer === 'left' }"
      >
        <div class="bv-room__rail-head">
          <h2 class="bv-room__rail-title">成员（{{ store.members.length }}）</h2>
          <button
            class="bv-room__rail-close"
            type="button"
            aria-label="关闭面板"
            @click="drawer = null"
          >
            ✕
          </button>
        </div>
        <ul class="bv-room__members">
          <li v-for="m in store.members" :key="m.id" class="bv-room__member">
            <span>{{ m.name }}</span>
            <span class="bv-room__member-role">
              {{ m.role === 'host' ? 'Host' : m.role === 'observer' ? '旁观' : '玩家' }}
            </span>
          </li>
        </ul>
      </aside>

      <section class="bv-room__main">
        <!-- 未开团 → 开局准备一屏（剧本 + 角色 + 开始），一级可见，不再藏进右栏 -->
        <SetupPanel v-if="!store.activeSessionId" />

        <div v-else ref="listEl" class="bv-room__messages">
          <MessageCard
            v-for="msg in ordered"
            :key="msg.seq"
            :msg="msg"
            :sender-name="senderName(msg)"
            :judge-label="judgeLabel(msg)"
            :judge-class="judgeClass(msg)"
            :kind-label="diceKindLabel(msg)"
            :target-label="diceTargetLabel(msg)"
            :nat-badge="diceNatBadge(msg)"
          />
          <!-- KP 叙事流式占位（T-M3-08）：delta 期间显示，落盘广播 + done 后由完整消息取代 -->
          <blockquote v-if="store.streaming" class="bv-room__streaming">
            <p class="bv-room__streaming-text">{{ store.streaming.content }}<span>▍</span></p>
          </blockquote>
          <p
            v-if="!store.streaming && !ordered.some((m) => m.type !== 'system')"
            class="bv-room__empty"
          >
            KP 正在酝酿开场——第一次 AI 回应可能要等几秒，别着急。
          </p>
        </div>

        <p v-if="store.activeSessionId && store.error" class="bv-room__error">{{ store.error }}</p>

        <p v-if="store.activeSessionId" class="bv-room__dice-hint">
          <code>.r 1d100&lt;=60</code> 掷骰 · <code>.rh</code> 暗骰（仅你与 KP 可见）
        </p>

        <!-- 迭代1：未开团时隐藏输入区——禁用状态的输入框只会让人困惑 -->
        <div v-if="store.activeSessionId" class="bv-room__composer">
          <div class="bv-room__modes" role="tablist">
            <button
              class="bv-room__mode"
              :class="{ 'bv-room__mode--active': mode === 'ic' }"
              type="button"
              @click="mode = 'ic'"
            >
              IC
            </button>
            <button
              class="bv-room__mode"
              :class="{ 'bv-room__mode--active': mode === 'ooc' }"
              type="button"
              @click="mode = 'ooc'"
            >
              OOC
            </button>
          </div>
          <input
            v-model="draft"
            class="bv-room__draft"
            :placeholder="
              canSend
                ? mode === 'ic'
                  ? '以角色行动…'
                  : 'OutOfCharacter…'
                : store.activeSessionId
                  ? '旁观视角不能发言'
                  : '尚未开团'
            "
            :disabled="!canSend"
            @keydown.enter="send"
          />
          <button class="bv-room__send" :disabled="!canSend || !draft.trim()" @click="send">
            发送
          </button>
        </div>
      </section>

      <aside
        class="bv-room__rail bv-room__rail--right"
        :class="{ 'bv-room__rail--open': drawer === 'right' }"
      >
        <div class="bv-room__rail-head">
          <nav class="bv-room__tabs" role="tablist">
            <button
              v-for="tab in railTabs"
              :key="tab.key"
              class="bv-room__tab"
              :class="{ 'bv-room__tab--active': railTab === tab.key }"
              type="button"
              role="tab"
              :aria-selected="railTab === tab.key"
              @click="railTab = tab.key"
            >
              {{ tab.label }}
            </button>
          </nav>
          <button
            class="bv-room__rail-close"
            type="button"
            aria-label="关闭面板"
            @click="drawer = null"
          >
            ✕
          </button>
        </div>

        <StateBoardPanel v-if="railTab === 'board'" />
        <CardImportPanel v-else-if="railTab === 'cards'" />
        <WorldBookEditor v-else-if="railTab === 'worldbook'" />
        <!-- 2026-10-09 修复：这里曾是一段内联的「生成 Prompt 预览」简化版，
             导致 KpConsole（管理令牌/开团/剧本选择/角色概览/AI 设置）整块没上屏 -->
        <KpConsole v-else-if="railTab === 'kp'" />
        <p v-else class="bv-room__rail-hint">
          {{ railTabs.find((t) => t.key === railTab)?.label }}（建设中）
        </p>
      </aside>

      <!-- 抽屉遮罩：只在窄屏出现，点它即收起面板 -->
      <div v-if="drawer" class="bv-room__scrim" role="presentation" @click="drawer = null"></div>
    </div>
  </main>
</template>

<style scoped>
.bv-room {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bv-bg-canvas);
  color: var(--bv-text-primary);
}
.bv-room__topbar {
  display: flex;
  align-items: center;
  gap: var(--bv-space-4);
  padding: var(--bv-space-3) var(--bv-space-5);
  border-bottom: 1px solid var(--bv-line-subtle);
  background: var(--bv-bg-surface);
  font-size: 13px;
}
.bv-room__title {
  font-weight: 600;
}
.bv-room__session {
  color: var(--bv-text-secondary);
}
.bv-room__offline {
  margin-left: auto;
  color: var(--bv-judge-fail);
}
.bv-room__body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: var(--bv-rail-left) 1fr var(--bv-rail-right);
}
.bv-room__rail {
  overflow-y: auto;
  padding: var(--bv-space-4);
  border-right: 1px solid var(--bv-line-subtle);
  background: var(--bv-bg-surface);
  font-size: 13px;
}
.bv-room__rail--right {
  border-right: none;
  border-left: 1px solid var(--bv-line-subtle);
}
.bv-room__rail-title {
  margin: 0 0 var(--bv-space-3);
  font-size: 12px;
  color: var(--bv-text-tertiary);
  letter-spacing: 0.1em;
}
.bv-room__tabs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--bv-space-1);
  margin-bottom: var(--bv-space-3);
}
.bv-room__tab {
  padding: var(--bv-space-1) var(--bv-space-2);
  border: 1px solid var(--bv-line-subtle);
  border-radius: var(--bv-radius-card);
  background: transparent;
  color: var(--bv-text-secondary);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.bv-room__tab--active {
  background: var(--bv-bg-elevated);
  color: var(--bv-text-primary);
  border-color: var(--bv-line-strong);
}
.bv-room__members {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--bv-space-2);
}
.bv-room__member {
  display: flex;
  justify-content: space-between;
  gap: var(--bv-space-2);
}
.bv-room__member-role {
  color: var(--bv-text-tertiary);
}
.bv-room__rail-hint {
  color: var(--bv-text-tertiary);
  font-size: 12px;
}
.bv-room__preview-btn {
  width: 100%;
  margin-bottom: var(--bv-space-3);
}
.bv-room__preview {
  display: flex;
  flex-direction: column;
  gap: var(--bv-space-1);
}
.bv-room__preview-title {
  margin: var(--bv-space-3) 0 var(--bv-space-1);
  font-size: 12px;
  color: var(--bv-text-secondary);
}
.bv-room__preview-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--bv-space-1);
  font-size: 12px;
}
.bv-room__preview-list li {
  display: flex;
  justify-content: space-between;
  gap: var(--bv-space-2);
  color: var(--bv-text-secondary);
}
.bv-room__preview-over {
  color: var(--bv-judge-fail);
}
.bv-room__preview-msg {
  font-size: 12px;
  color: var(--bv-text-secondary);
}
.bv-room__preview-msg pre {
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
.bv-room__main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.bv-room__messages {
  flex: 1;
  overflow-y: auto;
  padding: var(--bv-space-4);
  display: flex;
  flex-direction: column;
  gap: var(--bv-space-3);
}
.bv-room__empty {
  color: var(--bv-text-tertiary);
  font-size: 13px;
  text-align: center;
}
.bv-room__streaming {
  margin: 0;
  padding: var(--bv-space-3) var(--bv-space-4);
  border: 1px solid var(--bv-line-subtle);
  border-left: 3px solid var(--bv-accent);
  border-radius: var(--bv-radius-card);
  background: var(--bv-bg-elevated);
  font-size: 14px;
  line-height: 1.6;
}
.bv-room__streaming-text {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.bv-room__error {
  margin: 0;
  padding: var(--bv-space-2) var(--bv-space-4);
  font-size: 12px;
  color: var(--bv-judge-fail);
}
.bv-room__start {
  display: flex;
  gap: var(--bv-space-2);
  padding: 0 var(--bv-space-4) var(--bv-space-2);
}
.bv-room__module {
  flex: 1;
  padding: var(--bv-space-3);
  border: 1px solid var(--bv-line-subtle);
  border-radius: var(--bv-radius-card);
  background: var(--bv-bg-elevated);
  color: var(--bv-text-primary);
  font: inherit;
}
.bv-room__load-samples {
  margin-left: var(--bv-space-2);
  padding: 2px 10px;
  border: 1px solid var(--bv-line-subtle);
  border-radius: var(--bv-radius-control);
  background: transparent;
  color: var(--bv-accent);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.bv-room__code {
  font-family: var(--bv-font-mono);
  letter-spacing: 0.18em;
  color: var(--bv-accent-lift);
}
.bv-room__copy {
  margin: 0 var(--bv-space-2);
  padding: 2px 8px;
  border: 1px solid var(--bv-line-subtle);
  border-radius: var(--bv-radius-control);
  background: transparent;
  color: var(--bv-text-secondary);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.bv-room__me {
  color: var(--bv-text-tertiary);
}
.bv-room__leave {
  padding: 2px 10px;
  border: 1px solid var(--bv-line-subtle);
  border-radius: var(--bv-radius-control);
  background: transparent;
  color: var(--bv-text-secondary);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.bv-room__leave:hover {
  color: var(--bv-judge-fail);
  border-color: var(--bv-judge-fail);
}
.bv-room__dice-hint {
  margin: 0;
  padding: var(--bv-space-1) var(--bv-space-4);
  border-top: 1px solid var(--bv-line-subtle);
  background: var(--bv-bg-surface);
  color: var(--bv-text-tertiary);
  font-size: 11px;
}
.bv-room__dice-hint code {
  font-family: ui-monospace, monospace;
  color: var(--bv-text-secondary);
}
.bv-room__composer {
  display: flex;
  align-items: center;
  gap: var(--bv-space-2);
  padding: var(--bv-space-3) var(--bv-space-4);
  border-top: 1px solid var(--bv-line-subtle);
  background: var(--bv-bg-surface);
}
.bv-room__modes {
  display: flex;
  gap: var(--bv-space-1);
}
.bv-room__mode {
  padding: var(--bv-space-2) var(--bv-space-3);
  border: 1px solid var(--bv-line-subtle);
  border-radius: var(--bv-radius-card);
  background: transparent;
  color: var(--bv-text-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.bv-room__mode--active {
  background: var(--bv-bg-elevated);
  color: var(--bv-text-primary);
  border-color: var(--bv-line-strong);
}
.bv-room__draft {
  flex: 1;
  padding: var(--bv-space-3);
  border: 1px solid var(--bv-line-subtle);
  border-radius: var(--bv-radius-card);
  background: var(--bv-bg-elevated);
  color: var(--bv-text-primary);
  font: inherit;
}
.bv-room__draft:disabled {
  opacity: 0.5;
}
.bv-room__send {
  padding: var(--bv-space-2) var(--bv-space-4);
  border: none;
  border-radius: var(--bv-radius-card);
  background: var(--bv-accent);
  color: var(--bv-bg-canvas);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.bv-room__send:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
/* 抽屉按钮与关闭按钮：宽屏不需要（三栏常驻），窄屏才放出来 */
.bv-room__drawer-btn {
  display: none;
  padding: var(--bv-space-1) var(--bv-space-2);
  border: 1px solid var(--bv-line-subtle);
  border-radius: var(--bv-radius-control);
  background: transparent;
  color: var(--bv-text-secondary);
  font: inherit;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}
.bv-room__drawer-btn--tail {
  margin-left: auto;
}
.bv-room__rail-head {
  display: flex;
  align-items: flex-start;
  gap: var(--bv-space-2);
}
.bv-room__rail-head .bv-room__tabs {
  flex: 1;
  margin-bottom: var(--bv-space-3);
}
.bv-room__rail-close {
  display: none;
  flex: none;
  padding: var(--bv-space-1) var(--bv-space-2);
  border: 1px solid var(--bv-line-subtle);
  border-radius: var(--bv-radius-control);
  background: transparent;
  color: var(--bv-text-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}
.bv-room__scrim {
  display: none;
}

@media (max-width: 1024px) {
  /* 手机单栏 + 抽屉（设计基线：桌面优先，移动端侧栏改为可唤出，而不是直接藏掉） */
  .bv-room__body {
    grid-template-columns: 1fr;
  }
  .bv-room__drawer-btn,
  .bv-room__rail-close {
    display: inline-flex;
  }
  .bv-room__scrim {
    display: block;
    position: fixed;
    inset: 0;
    z-index: 15;
    background: rgba(0, 0, 0, 0.5);
  }
  .bv-room__rail {
    position: fixed;
    top: 0;
    bottom: 0;
    z-index: 20;
    overflow-y: auto;
    transition: transform 0.22s ease;
    box-shadow: 0 0 24px rgba(0, 0, 0, 0.45);
  }
  .bv-room__rail--left {
    left: 0;
    width: min(88vw, var(--bv-rail-left));
    transform: translateX(-100%);
  }
  .bv-room__rail--right {
    right: 0;
    left: auto;
    width: min(88vw, var(--bv-rail-right));
    transform: translateX(100%);
  }
  .bv-room__rail--left.bv-room__rail--open,
  .bv-room__rail--right.bv-room__rail--open {
    transform: translateX(0);
  }
}

@media (max-width: 600px) {
  .bv-room__topbar {
    flex-wrap: wrap;
    gap: var(--bv-space-2);
    padding: var(--bv-space-2) var(--bv-space-3);
    font-size: 12px;
  }
  /* 迭代 3：窄屏顶栏只留「邀请码 + 复制 + 会话状态」，自己的名字不占位 */
  .bv-room__me {
    display: none;
  }
  .bv-room__messages {
    padding: var(--bv-space-3) var(--bv-space-2);
  }
  .bv-room__composer {
    padding: var(--bv-space-2);
  }
  .bv-room__draft {
    min-width: 0;
  }
}
</style>
