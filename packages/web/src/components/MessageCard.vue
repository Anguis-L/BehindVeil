<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Message } from '@behindveil/shared';
import { useSessionStore } from '../stores/session';

const store = useSessionStore();

const props = defineProps<{
  msg: Message;
  senderName: string;
  judgeLabel: string | null;
  judgeClass: string;
  /** 判定种类中文名（v2 FR-21：属性检定 / 豁免 / 攻击 / 先攻 …） */
  kindLabel: string | null;
  /** 判定目标值标签：5e 攻击为 AC、其余为 DC（COC 的目标值已在骰式里，不重复展示） */
  targetLabel: string | null;
  /** nat20 / nat1 徽章（仅 5e：面值判定，COC 的大成功是骰值 1 而非 nat20） */
  natBadge: string | null;
}>();

/** 先攻提请已发出的本地反馈（不落盘：提请本身是一条密语消息） */
const initiativeAsked = ref(false);

const canJoinInitiative = computed(
  () => props.msg.type === 'dice' && !props.msg.hidden && store.stateBoard !== null,
);

/**
 * 「加入先攻」（T-M12-03，FR-37）：Host 直接写板；玩家只能提请（密语给 Host）。
 * 看板红线——只搬运骰值，不做任何轮次推进或自动结算。
 */
function joinInitiative(): void {
  const board = store.stateBoard;
  if (!board) return;
  const label = props.senderName;
  const roll = props.msg.type === 'dice' ? props.msg.roll.total : 0;
  if (store.role !== 'host') {
    const host = store.members?.find((m) => m.role === 'host');
    if (host) {
      store.whisper(host.id, `【先攻提请】${label} 掷出 ${roll}，请 Host 加入先攻看板`);
      initiativeAsked.value = true;
    }
    return;
  }
  const scene = board.scene;
  const entry = {
    ref: (props.msg.type === 'dice' ? props.msg.senderId : undefined) ?? `npc:${label}`,
    label,
    roll,
  };
  const order = [...(scene.initiative?.order ?? []), entry].sort((a, b) => b.roll - a.roll);
  store.updateState({
    scene: {
      ...scene,
      initiative: { order, currentIdx: 0, round: scene.initiative?.round ?? 1 },
    },
  });
}
</script>

<template>
  <!-- 消息卡（T-M1-10）：七类消息的玩家端渲染，配色只取 tokens.css 变量 -->
  <article v-if="msg.type === 'ic'" class="bv-msg bv-msg--ic">
    <span class="bv-msg__sender">{{ senderName }}</span>
    <p class="bv-msg__content">{{ msg.content }}</p>
  </article>

  <article
    v-else-if="msg.type === 'ooc'"
    class="bv-msg bv-msg--ooc"
    :class="{ 'bv-msg--inset': msg.visibility === 'whisper' }"
  >
    <span class="bv-msg__sender">{{ senderName }}</span>
    <span class="bv-msg__badge">
      {{
        msg.visibility === 'whisper'
          ? `密语 → ${msg.targetId ?? ''}`
          : msg.visibility === 'host'
            ? '仅 Host 可见'
            : 'OOC'
      }}
    </span>
    <p class="bv-msg__content">{{ msg.content }}</p>
    <p v-if="msg.visibility === 'whisper'" class="bv-msg__footnote">
      仅发送者与收件人可见，不注入 AI 上下文
    </p>
  </article>

  <p v-else-if="msg.type === 'system'" class="bv-msg bv-msg--system">{{ msg.content }}</p>

  <article v-else-if="msg.type === 'dice'" class="bv-dice-card" :class="judgeClass">
    <div class="bv-dice-card__head">
      <span class="bv-dice-card__sender">{{ senderName }}</span>
      <span v-if="kindLabel" class="bv-dice-card__kind">{{ kindLabel }}</span>
      <span v-if="targetLabel" class="bv-dice-card__target">{{ targetLabel }}</span>
      <span class="bv-dice-card__expr">{{ msg.roll.expr }}</span>
      <span class="bv-dice-card__result">
        {{ msg.hidden ? '??' : msg.roll.total }}
      </span>
      <span v-if="judgeLabel" class="bv-dice-card__label">{{ judgeLabel }}</span>
      <span v-if="natBadge" class="bv-dice-card__label bv-dice-card__label--nat">
        {{ natBadge }}
      </span>
      <span v-if="msg.hidden" class="bv-dice-card__label bv-dice-card__label--hidden">
        结果隐藏
      </span>
    </div>
    <div class="bv-dice-card__audit">
      <span>骰值 {{ msg.hidden ? '[隐藏]' : JSON.stringify(msg.roll.rolls) }}</span>
      <span>保留 {{ msg.hidden ? '[隐藏]' : JSON.stringify(msg.roll.kept) }}</span>
      <span>流水号 #{{ msg.roll.audit.seq }}</span>
      <span>服务端掷骰 · 可复现</span>
    </div>
    <div v-if="canJoinInitiative" class="bv-dice-card__actions">
      <button class="bv-board__btn bv-board__btn--ghost" @click="joinInitiative">
        {{ store.role === 'host' ? '加入先攻' : '提请加入先攻' }}
      </button>
      <span v-if="initiativeAsked" class="bv-dice-card__hint">已密语 Host，等其录入</span>
    </div>
  </article>

  <blockquote v-else-if="msg.type === 'narration'" class="bv-msg bv-msg--narration">
    <p class="bv-msg__content">{{ msg.content }}<span v-if="msg.streaming">▍</span></p>
  </blockquote>

  <details v-else class="bv-msg bv-msg--snapshot">
    <summary>状态板快照 · 版本 {{ msg.stateBoard.version }}（已常驻注入后续 prompt）</summary>
    <pre class="bv-msg__pre">{{ JSON.stringify(msg.stateBoard, null, 2) }}</pre>
  </details>
</template>

<style scoped>
.bv-msg {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--bv-space-1);
  padding: var(--bv-space-3) var(--bv-space-4);
  border: 1px solid var(--bv-line-subtle);
  border-radius: var(--bv-radius-card);
  background: var(--bv-bg-elevated);
  font-size: 14px;
  line-height: 1.6;
}
.bv-msg__sender {
  font-size: 12px;
  font-weight: 600;
  color: var(--bv-text-secondary);
}
.bv-msg__badge {
  align-self: flex-start;
  padding: 1px var(--bv-space-2);
  border-radius: 999px;
  background: var(--bv-bg-sunken);
  color: var(--bv-text-tertiary);
  font-size: 11px;
}
.bv-msg__content {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.bv-msg__footnote {
  margin: 0;
  font-size: 11px;
  color: var(--bv-text-tertiary);
}
.bv-msg--inset {
  background: var(--bv-bg-inset);
}
.bv-msg--system {
  align-items: center;
  background: transparent;
  border: none;
  color: var(--bv-text-tertiary);
  font-size: 12px;
  text-align: center;
}
.bv-msg--narration {
  border-left: 3px solid var(--bv-accent);
  background: var(--bv-bg-elevated);
}
.bv-msg--snapshot summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--bv-text-secondary);
}
.bv-msg__pre {
  margin: var(--bv-space-2) 0 0;
  font-size: 11px;
  color: var(--bv-text-tertiary);
  overflow-x: auto;
}

/* 骰子卡：高度自适应 + 渐变色条（tokens.css 基线注释的实现），禁止写死高度 */
.bv-dice-card {
  height: auto;
  display: flex;
  flex-direction: column;
  gap: var(--bv-space-3);
  padding: var(--bv-space-4);
  border-radius: var(--bv-radius-card);
  background:
    linear-gradient(to right, var(--bv-judge) 0 6px, transparent 6px) no-repeat,
    var(--bv-bg-elevated);
}
.bv-dice-card__head {
  display: flex;
  align-items: baseline;
  gap: var(--bv-space-3);
}
.bv-dice-card__sender {
  font-size: 12px;
  font-weight: 600;
  color: var(--bv-text-secondary);
}
.bv-dice-card__expr {
  font-family: ui-monospace, monospace;
  color: var(--bv-text-secondary);
}
.bv-dice-card__kind,
.bv-dice-card__target {
  font-size: 12px;
  color: var(--bv-text-tertiary);
}
.bv-dice-card__target {
  font-family: ui-monospace, monospace;
}
.bv-dice-card__result {
  font-size: 20px;
  font-weight: 700;
  color: var(--bv-judge);
}
.bv-dice-card__label {
  padding: 1px var(--bv-space-2);
  border-radius: 999px;
  background: var(--bv-judge);
  color: var(--bv-bg-canvas);
  font-size: 12px;
  font-weight: 600;
}
.bv-dice-card__label--hidden {
  background: var(--bv-bg-sunken);
  color: var(--bv-text-tertiary);
}
/* nat20 / nat1：与判定色同色系但反白描边，避免与大成功/大失败徽章混淆 */
.bv-dice-card__label--nat {
  border: 1px solid var(--bv-judge);
  background: transparent;
  color: var(--bv-judge);
  font-family: ui-monospace, monospace;
  letter-spacing: 0.05em;
}
.bv-dice-card__actions {
  display: flex;
  align-items: center;
  gap: var(--bv-space-2);
  margin-top: var(--bv-space-1);
}
.bv-dice-card__hint {
  color: var(--bv-text-tertiary);
  font-size: 12px;
}
.bv-dice-card__audit {
  display: flex;
  flex-wrap: wrap;
  gap: var(--bv-space-3);
  padding: var(--bv-space-2) var(--bv-space-3);
  border-radius: var(--bv-radius-card);
  background: var(--bv-bg-sunken);
  color: var(--bv-text-tertiary);
  font-size: 11px;
  font-family: ui-monospace, monospace;
}
</style>
