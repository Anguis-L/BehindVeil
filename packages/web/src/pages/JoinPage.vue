<script setup lang="ts">
import { ref } from 'vue';
import { useSessionStore } from '../stores/session';

const store = useSessionStore();
const inviteCode = ref('');
const name = ref('');
const hostToken = ref('');
const joining = ref(false);

async function submit(): Promise<void> {
  if (inviteCode.value.length !== 6 || !name.value.trim() || joining.value) return;
  joining.value = true;
  try {
    await store.join(
      inviteCode.value.trim().toUpperCase(),
      name.value.trim(),
      hostToken.value.trim(),
    );
  } finally {
    joining.value = false;
  }
}
</script>

<template>
  <main class="bv-join">
    <form class="bv-join__card" @submit.prevent="submit">
      <h1 class="bv-join__title">BehindVeil</h1>
      <p class="bv-join__subtitle">输入邀请码进入跑团房间</p>

      <label class="bv-join__field">
        <span>邀请码</span>
        <input
          v-model="inviteCode"
          class="bv-join__input bv-join__input--code"
          maxlength="6"
          placeholder="A7K2Q9"
          autocomplete="off"
        />
      </label>

      <label class="bv-join__field">
        <span>昵称</span>
        <input v-model="name" class="bv-join__input" maxlength="50" placeholder="你在房间的名字" />
      </label>

      <details class="bv-join__advanced">
        <summary>建房者 / 重连高级选项</summary>
        <label class="bv-join__field">
          <span>建房者令牌（hostToken，可选）</span>
          <input v-model="hostToken" class="bv-join__input" autocomplete="off" />
        </label>
      </details>

      <p v-if="store.error" class="bv-join__error">{{ store.error }}</p>

      <button
        class="bv-join__submit"
        type="submit"
        :disabled="inviteCode.length !== 6 || !name.trim() || joining"
      >
        {{ joining ? '进入中…' : '进入房间' }}
      </button>
    </form>
  </main>
</template>

<style scoped>
.bv-join {
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: var(--bv-bg-canvas);
  color: var(--bv-text-primary);
}
.bv-join__card {
  width: min(360px, calc(100vw - 32px));
  display: flex;
  flex-direction: column;
  gap: var(--bv-space-4);
  padding: var(--bv-space-6);
  border: 1px solid var(--bv-line-subtle);
  border-radius: var(--bv-radius-card);
  background: var(--bv-bg-surface);
}
.bv-join__title {
  margin: 0;
  font-size: 24px;
  letter-spacing: 0.08em;
}
.bv-join__subtitle {
  margin: 0;
  color: var(--bv-text-secondary);
  font-size: 13px;
}
.bv-join__field {
  display: flex;
  flex-direction: column;
  gap: var(--bv-space-2);
  font-size: 13px;
  color: var(--bv-text-secondary);
}
.bv-join__input {
  padding: var(--bv-space-3);
  border: 1px solid var(--bv-line-subtle);
  border-radius: var(--bv-radius-card);
  background: var(--bv-bg-elevated);
  color: var(--bv-text-primary);
  font: inherit;
}
.bv-join__input--code {
  letter-spacing: 0.4em;
  text-transform: uppercase;
}
.bv-join__advanced summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--bv-text-tertiary);
}
.bv-join__error {
  margin: 0;
  font-size: 13px;
  color: var(--bv-judge-fail);
}
.bv-join__submit {
  padding: var(--bv-space-3);
  border: none;
  border-radius: var(--bv-radius-card);
  background: var(--bv-accent);
  color: var(--bv-bg-canvas);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.bv-join__submit:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
