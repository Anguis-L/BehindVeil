<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue';
import { useSessionStore } from '../stores/session';
import type { Message } from '@behindveil/shared';
import MessageCard from '../components/MessageCard.vue';

const store = useSessionStore();
const draft = ref('');
const mode = ref<'ic' | 'ooc'>('ic');
const moduleId = ref('');
const listEl = ref<HTMLElement | null>(null);

const canSend = computed(() => store.role !== 'observer' && store.activeSessionId !== null);

const ordered = computed(() => store.messages);

watch(
  () => store.messages.length,
  async () => {
    await nextTick();
    listEl.value?.scrollTo({ top: listEl.value.scrollHeight });
  },
);

function send(): void {
  if (!draft.value.trim() || !canSend.value) return;
  store.send(mode.value, draft.value);
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
  if (msg.type !== 'ic' && msg.type !== 'ooc') return '';
  return store.memberNameMap.get(msg.senderId) ?? msg.senderId;
}
</script>

<template>
  <main class="bv-room">
    <header class="bv-room__topbar">
      <span class="bv-room__title">{{ store.inviteCode }} · {{ store.name }}</span>
      <span class="bv-room__session">
        {{ store.activeSessionId ? `会话 ${store.activeSessionId}` : '尚未开团' }}
      </span>
      <span v-if="store.connectionLost" class="bv-room__offline">连接已断开，正在重连…</span>
    </header>

    <div class="bv-room__body">
      <aside class="bv-room__rail bv-room__rail--left">
        <h2 class="bv-room__rail-title">成员（{{ store.members.length }}）</h2>
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
        <div ref="listEl" class="bv-room__messages">
          <MessageCard
            v-for="msg in ordered"
            :key="msg.seq"
            :msg="msg"
            :sender-name="senderName(msg)"
            :judge-label="judgeLabel(msg)"
            :judge-class="judgeClass(msg)"
          />
          <p v-if="ordered.length === 0" class="bv-room__empty">还没有消息——开团后开始冒险吧。</p>
        </div>

        <p v-if="store.error" class="bv-room__error">{{ store.error }}</p>

        <div v-if="store.role === 'host' && !store.activeSessionId" class="bv-room__start">
          <input
            v-model="moduleId"
            class="bv-room__module"
            placeholder="模组 ID（如 mountains-of-madness）"
          />
          <button
            class="bv-room__send"
            :disabled="!moduleId.trim()"
            @click="store.startSession(moduleId.trim())"
          >
            开团
          </button>
        </div>

        <div class="bv-room__composer">
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

      <aside class="bv-room__rail bv-room__rail--right">
        <h2 class="bv-room__rail-title">侧栏</h2>
        <p class="bv-room__rail-hint">KP 控制台 / 状态板随 M2–M5 里程碑开放。</p>
      </aside>
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
@media (max-width: 1024px) {
  /* 手机单栏降级（设计基线：桌面优先，移动端收起两侧栏） */
  .bv-room__body {
    grid-template-columns: 1fr;
  }
  .bv-room__rail {
    display: none;
  }
}
</style>
