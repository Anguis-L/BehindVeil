<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useSessionStore } from '../stores/session';
import LlmSettingsPanel from '../components/LlmSettingsPanel.vue';

/**
 * 入口页（2026-10-08 可用性改造）。
 *
 * 原版只有一个「输入邀请码」框——新房主进来看到它，根本不知道房间从哪儿来，
 * 于是「不知道怎么新建房间」成了第一道墙。现在入口页同时承担三件事：
 * ① 加入房间（被邀请的人）② 新建房间（开团的人）③ 接 AI 模型（KP 的脑子）。
 * 底部再给一条「三步走」的路标，第一次用的人不用猜。
 */

const store = useSessionStore();
const mode = ref<'join' | 'create'>('join');
const showLlm = ref(false);

const inviteCode = ref('');
const name = ref('');
const hostToken = ref('');
const joining = ref(false);

// 建房表单
const roomName = ref('');
const hostName = ref('');
const memberLimit = ref(6);
const adminTokenDraft = ref('');
const creating = ref(false);
const copied = ref(false);

// 座席恢复（2026-10-07）：刷新后凭 sessionStorage 原座重进；失败则回填邀请码与昵称
onMounted(() => {
  void store.restoreSeat().then((res) => {
    if (!res.restored && res.prefill) {
      inviteCode.value = res.prefill.inviteCode;
      name.value = res.prefill.name;
    }
  });
});

async function submitJoin(): Promise<void> {
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

async function submitCreate(): Promise<void> {
  if (!roomName.value.trim() || !hostName.value.trim() || creating.value) return;
  creating.value = true;
  try {
    // 令牌先落座（sessionStorage），后续所有管理面请求都会带上它
    store.setAdminToken(adminTokenDraft.value);
    const ok = await store.createRoom(roomName.value.trim(), memberLimit.value);
    // 少一步：建好直接进房，邀请码进房后在顶部常驻可复制，不再停留结果页
    if (ok) await enterCreatedRoom();
  } finally {
    creating.value = false;
  }
}

/** 建房后一键进入自己的房间：邀请码与建房者令牌都已在手，不用手抄 */
async function enterCreatedRoom(): Promise<void> {
  const created = store.createdRoom;
  if (!created) return;
  joining.value = true;
  try {
    await store.join(created.inviteCode, hostName.value.trim(), created.hostToken);
  } finally {
    joining.value = false;
  }
}

async function copyInvite(): Promise<void> {
  const created = store.createdRoom;
  if (!created) return;
  try {
    await navigator.clipboard.writeText(created.inviteCode);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1600);
  } catch {
    copied.value = false; // 浏览器不给权限时，用户手抄即可（邀请码本来就短）
  }
}
</script>

<template>
  <main class="bv-join">
    <section class="bv-join__card">
      <h1 class="bv-join__title">BehindVeil</h1>
      <p class="bv-join__subtitle">AI 当守秘人的多人文字跑团</p>

      <div class="bv-join__modes" role="tablist">
        <button
          class="bv-join__mode"
          :class="{ 'is-active': mode === 'join' }"
          type="button"
          role="tab"
          :aria-selected="mode === 'join'"
          @click="mode = 'join'"
        >
          加入房间
        </button>
        <button
          class="bv-join__mode"
          :class="{ 'is-active': mode === 'create' }"
          type="button"
          role="tab"
          :aria-selected="mode === 'create'"
          @click="mode = 'create'"
        >
          新建房间
        </button>
      </div>

      <!-- 建房结果：邀请码 + 一键进入 -->
      <div v-if="mode === 'create' && store.createdRoom" class="bv-join__done">
        <p class="bv-join__done-title">房间「{{ store.createdRoom.name }}」建好了</p>
        <div class="bv-join__code">
          <span class="bv-join__code-value">{{ store.createdRoom.inviteCode }}</span>
          <button class="bv-join__copy" type="button" @click="copyInvite">
            {{ copied ? '已复制' : '复制' }}
          </button>
        </div>
        <p class="bv-join__hint">把这 6 位邀请码发给朋友，他们在这页选「加入房间」就能进来。</p>
        <button class="bv-join__submit" type="button" :disabled="joining" @click="enterCreatedRoom">
          {{ joining ? '进入中…' : '进入我的房间' }}
        </button>
        <p class="bv-join__hint">
          建房者权限已自动带上（关掉浏览器标签页会失效，想长期当建房者请另行保存建房者令牌）。
        </p>
      </div>

      <form v-else-if="mode === 'join'" class="bv-join__form" @submit.prevent="submitJoin">
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
          <input
            v-model="name"
            class="bv-join__input"
            maxlength="50"
            placeholder="你在房间的名字"
          />
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

      <form v-else class="bv-join__form" @submit.prevent="submitCreate">
        <label class="bv-join__field">
          <span>房间名</span>
          <input
            v-model="roomName"
            class="bv-join__input"
            maxlength="50"
            placeholder="周六夜的雾桥驿站"
          />
        </label>

        <label class="bv-join__field">
          <span>你在房间里的昵称</span>
          <input
            v-model="hostName"
            class="bv-join__input"
            maxlength="50"
            placeholder="比如：守秘人老王"
          />
        </label>

        <label class="bv-join__field">
          <span>最多几人（含你）</span>
          <input
            v-model.number="memberLimit"
            class="bv-join__input"
            type="number"
            min="2"
            max="64"
          />
        </label>

        <details class="bv-join__advanced">
          <summary>这台服务器设了管理令牌？点这里填</summary>
          <label class="bv-join__field">
            <span>管理令牌（不知道就留空试试）</span>
            <input v-model="adminTokenDraft" class="bv-join__input" autocomplete="off" />
          </label>
        </details>

        <p v-if="store.error" class="bv-join__error">{{ store.error }}</p>

        <button
          class="bv-join__submit"
          type="submit"
          :disabled="!roomName.trim() || !hostName.trim() || creating"
        >
          {{ creating ? '创建中…' : '创建房间' }}
        </button>
      </form>

      <div class="bv-join__setup">
        <button class="bv-join__link" type="button" @click="showLlm = true">⚙ AI 模型设置</button>
        <span class="bv-join__setup-note">让 AI 当 KP 之前，得先告诉它接哪个模型</span>
      </div>

      <ol class="bv-join__steps">
        <li><strong>新建房间</strong> → 拿到邀请码发给朋友</li>
        <li><strong>接一个 AI 模型</strong> → 它是守秘人的脑子</li>
        <li><strong>进房选剧本、认领角色</strong> → 开团开跑</li>
      </ol>
    </section>

    <LlmSettingsPanel v-if="showLlm" @close="showLlm = false" />
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
  width: min(400px, calc(100vw - 32px));
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
  margin: -8px 0 0;
  color: var(--bv-text-secondary);
  font-size: 13px;
}
.bv-join__modes {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--bv-space-2);
  padding: 4px;
  border-radius: var(--bv-radius-card);
  background: var(--bv-bg-sunken);
}
.bv-join__mode {
  padding: var(--bv-space-2);
  border: none;
  border-radius: var(--bv-radius-control);
  background: transparent;
  color: var(--bv-text-secondary);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.bv-join__mode.is-active {
  background: var(--bv-bg-elevated);
  color: var(--bv-text-primary);
  font-weight: 600;
}
.bv-join__form {
  display: flex;
  flex-direction: column;
  gap: var(--bv-space-4);
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
.bv-join__advanced .bv-join__field {
  margin-top: var(--bv-space-3);
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
.bv-join__done {
  display: flex;
  flex-direction: column;
  gap: var(--bv-space-3);
}
.bv-join__done-title {
  margin: 0;
  font-size: 14px;
}
.bv-join__code {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--bv-space-3);
  padding: var(--bv-space-4);
  border: 1px solid var(--bv-line-strong);
  border-radius: var(--bv-radius-card);
  background: var(--bv-bg-sunken);
}
.bv-join__code-value {
  font-family: var(--bv-font-mono);
  font-size: 26px;
  letter-spacing: 0.24em;
  color: var(--bv-accent-lift);
}
.bv-join__copy {
  padding: 4px 10px;
  border: 1px solid var(--bv-line-subtle);
  border-radius: var(--bv-radius-control);
  background: transparent;
  color: var(--bv-text-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.bv-join__hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--bv-text-tertiary);
}
.bv-join__setup {
  display: flex;
  align-items: center;
  gap: var(--bv-space-3);
  padding-top: var(--bv-space-3);
  border-top: 1px solid var(--bv-line-subtle);
}
.bv-join__link {
  border: none;
  background: transparent;
  color: var(--bv-accent);
  font: inherit;
  font-size: 13px;
  padding: 0;
  cursor: pointer;
}
.bv-join__setup-note {
  font-size: 11px;
  color: var(--bv-text-tertiary);
}
.bv-join__steps {
  margin: 0;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--bv-text-tertiary);
}
.bv-join__steps strong {
  color: var(--bv-text-secondary);
}
</style>
