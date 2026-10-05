import { defineStore } from 'pinia';
import { io, type Socket } from 'socket.io-client';
import {
  PROTOCOL_VERSION,
  type KpMetricsPayload,
  type KpMetricsResultPayload,
  type Member,
  type MemberRole,
  type Message,
  type MsgSendPayload,
  type PipelineTracePayload,
  type RoomJoinPayload,
  type Session,
  type StateBoard,
  type StatePatch,
} from '@behindveil/shared';
import { readAdminToken, writeAdminToken } from '../admin-token.js';
import type { SessionSettingsPatch } from '../kp-console.js';

/**
 * 会话状态（T-M1-10）：进房 → 消息流 → 断线重连。
 * Socket 实例不进 Pinia state（不可序列化），挂在模块级变量上。
 */

interface JoinAck {
  ok: boolean;
  roomId?: string;
  memberId?: string;
  role?: MemberRole;
  activeSessionId?: string | null;
  lastSeq?: number;
  /** 提案增量：进房即带回名册 */
  members?: Member[];
  code?: string;
  message?: string;
}

interface ServerToClientEvents {
  'msg:broadcast': (payload: { msg: Message }) => void;
  'narration:delta': (payload: { seq: number; delta: string }) => void;
  'narration:done': (payload: { seq: number }) => void;
  'error:app': (payload: { code: string; message: string }) => void;
  'kp:promptPreview': (payload: { pipeline: PromptPreview }) => void;
  'kp:metricsResult': (payload: KpMetricsResultPayload) => void;
  /** 状态板广播（T-M5-06/10，FR-09）：变更后全员一致 */
  'state:broadcast': (payload: { stateBoard: StateBoard }) => void;
}

/** kp:promptPreview 承载的管线 trace（T-M2-05/09，FR-13）：类型直接取 shared 契约 */
export type PromptPreview = PipelineTracePayload;

interface SessionStartAck {
  ok: boolean;
  session?: { id: string };
  code?: string;
  message?: string;
}

interface ClientToServerEvents {
  'room:join': (payload: RoomJoinPayload, ack: (resp: JoinAck) => void) => void;
  'msg:send': (payload: MsgSendPayload) => void;
  /** 玩家骰（T-M4-02，FR-06/14）：暗骰结果仅 Host 与自己可见（D-10） */
  'dice:roll': (payload: { expr: string; hidden?: boolean }) => void;
  'session:start': (
    payload: {
      moduleId: string;
      settings: {
        provider: string;
        model: string;
        temperature: number;
        maxHistoryMessages: number;
        worldBookBudgetTokens: number;
        scanDepth: number;
        contextWindowTokens: number;
        outputReserveTokens: number;
      };
    },
    ack: (resp: SessionStartAck) => void,
  ) => void;
  'kp:previewPrompt': (payload: { seq?: number }) => void;
  /** 房内实时指标（T-M6-03/05）：仅 Host，缺省取当前活跃会话 */
  'kp:metrics': (payload: KpMetricsPayload) => void;
  /** 状态板编辑（T-M5-06/10）：仅 Host，乐观锁；过期回 E-ST-01 并广播最新版 */
  'state:update': (payload: { patch: StatePatch; expectedVersion: number }) => void;
  /** 快照生成（T-M5-07/10）：仅 Host，SnapshotMsg 入流 */
  'state:snapshot': (payload: Record<string, never>) => void;
}

/** 管理面 REST 401 提示（前端默认不带 X-Admin-Token，必须让 KP 看得见原因） */
const ADMIN_TOKEN_HINT = '需要管理令牌，请在 KP 控制台填写';

let socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;

export const useSessionStore = defineStore('session', {
  state: () => ({
    view: 'join' as 'join' | 'room',
    inviteCode: '',
    name: '',
    roomId: '',
    memberId: '',
    role: 'player' as MemberRole,
    activeSessionId: null as string | null,
    members: [] as Member[],
    messages: [] as Message[],
    maxSeq: 0,
    connected: false,
    connectionLost: false,
    error: '',
    /** KP prompt 预览（T-M2-09，FR-13）：kp:promptPreview 回包 */
    preview: null as PromptPreview | null,
    previewLoading: false,
    /** KP 控制台：本会话实时指标（T-M6-05，kp:metricsResult 回包） */
    metrics: null as KpMetricsResultPayload | null,
    metricsLoading: false,
    /** KP 控制台：本房会话列表（管理面 REST，需令牌） */
    sessions: [] as Session[],
    sessionsLoading: false,
    /** 管理令牌：仅内存 + sessionStorage，不落 localStorage（见 admin-token.ts） */
    adminToken: readAdminToken(),
    /**
     * 正在流式的 KP 叙事占位（T-M3-08，FR-05）。seq 为触发消息 seq（服务端
     * narration:delta 的 payload，仅作占位标识）；落盘广播 + narration:done 到达
     * 后清除，完整叙事以 msg:broadcast 进时间线。占位永不入 messages（seq 语义不同）。
     */
    streaming: null as { seq: number; content: string } | null,
    /** 状态板（T-M5-10，FR-09）：GET /rooms/:id/state 拉初始，state:broadcast 增量维护 */
    stateBoard: null as StateBoard | null,
  }),

  getters: {
    memberNameMap(state): Map<string, string> {
      return new Map(state.members.map((m) => [m.id, m.name]));
    },
  },

  actions: {
    async join(inviteCode: string, name: string, hostToken: string): Promise<void> {
      this.error = '';
      this.inviteCode = inviteCode;
      this.name = name;

      const payload: RoomJoinPayload = {
        inviteCode,
        name,
        wantRole: 'player',
        ...(hostToken ? { hostToken } : {}),
        // 断线重连：携带原身份与已收 seq，服务端补发缺口（T-M1-08）
        ...(this.memberId ? { memberId: this.memberId } : {}),
        ...(this.memberId && this.maxSeq > 0 ? { lastSeq: this.maxSeq } : {}),
      };

      const ack = await new Promise<JoinAck>((resolve) => {
        getSocket().emit('room:join', payload, (resp) => resolve(resp));
      });

      if (!ack.ok) {
        this.error = ack.message ?? '加入失败';
        socket?.disconnect();
        socket = null;
        return;
      }

      this.roomId = ack.roomId ?? '';
      this.memberId = ack.memberId ?? '';
      this.role = ack.role ?? 'player';
      this.activeSessionId = ack.activeSessionId ?? null;
      this.members = ack.members ?? [];
      this.view = 'room';

      // 首次进房：REST 拉最近 50 条（决议 ④）；重连缺口由服务端 lastSeq 补发
      if (this.maxSeq === 0) await this.fetchHistory();
      // 状态板初始拉取（T-M5-10）：之后靠 state:broadcast 增量维护
      await this.fetchState();
    },

    /** 状态板当前值（T-M5-10）：进房/开团/刷新后调用；未开团为 null */
    async fetchState(): Promise<void> {
      if (!this.roomId) return;
      try {
        // 玩家侧端点：免管理令牌（路由分离口径，与 /public 一致）
        const res = await fetch(`/rooms/${this.roomId}/state`);
        if (!res.ok) return;
        const body = (await res.json()) as { stateBoard: StateBoard | null };
        this.stateBoard = body.stateBoard;
      } catch {
        // 拉取失败不打断进房；变更广播到达时会覆盖
      }
    },

    /**
     * Host 编辑状态板（T-M5-06/10）：乐观锁，expectedVersion 取本地当前版；
     * 过期回 E-ST-01——服务端冲突时会广播最新版，本地板自动对齐后可重试。
     */
    updateState(patch: StatePatch): void {
      if (this.role !== 'host' || !this.stateBoard) return;
      getSocket().emit('state:update', { patch, expectedVersion: this.stateBoard.version });
    },

    /** Host 生成快照（T-M5-07/10）：SnapshotMsg 入流 */
    requestSnapshot(): void {
      if (this.role !== 'host' || !this.activeSessionId) return;
      getSocket().emit('state:snapshot', {});
    },

    async fetchHistory(): Promise<void> {
      if (!this.roomId) return;
      const params = new URLSearchParams({ limit: '50' });
      if (this.activeSessionId) params.set('sessionId', this.activeSessionId);
      try {
        const res = await fetch(`/rooms/${this.roomId}/messages?${params.toString()}`);
        if (!res.ok) return;
        const list = (await res.json()) as Message[];
        this.ingest(list.slice().reverse()); // 接口降序 → 恢复为时间线正序
      } catch {
        // 历史拉取失败不打断进房，实时流仍可用
      }
    },

    send(type: 'ic' | 'ooc', content: string): void {
      if (!content.trim()) return;
      getSocket().emit('msg:send', { type, content });
    },

    /**
     * 密语（T-M12-03：玩家「加入先攻」提请走这条既有通道，零新增 socket 事件——
     * 玩家无状态板写权限，改板必须经 Host，密语是最轻的提请方式）。
     */
    whisper(targetId: string, content: string): void {
      if (!content.trim()) return;
      getSocket().emit('msg:send', { type: 'ooc', content, targetId });
    },

    /** 掷骰（T-M4-02）：骰式是否合法由服务端判定，非法回 E-DICE-01 行内提示 */
    roll(expr: string, hidden = false): void {
      if (!expr.trim()) return;
      getSocket().emit('dice:roll', { expr, hidden });
    },

    startSession(moduleId: string): void {
      // settings 全字段必填（SessionSettingsSchema）；web 端 v1 以默认值开团，
      // 细调走管理面 PATCH defaultSessionSettings（M6 控制台完善）
      getSocket().emit(
        'session:start',
        {
          moduleId,
          settings: {
            provider: 'openai-compat',
            model: '',
            temperature: 0.7,
            maxHistoryMessages: 40,
            worldBookBudgetTokens: 2000,
            scanDepth: 4,
            contextWindowTokens: 32_768,
            outputReserveTokens: 2_048,
          },
        },
        (resp) => {
          if (resp.ok && resp.session) {
            this.activeSessionId = resp.session.id;
            void this.fetchState(); // 开团后拉装配了声明的初始板（T-M5-04/10）
          } else {
            this.error = resp.message ?? '开团失败';
          }
        },
      );
    },

    requestPreview(): void {
      // host only（服务端同校验）；回包走 kp:promptPreview 监听
      if (this.role !== 'host' || !this.activeSessionId) return;
      this.previewLoading = true;
      getSocket().emit('kp:previewPrompt', {});
    },

    /** 房内实时指标（T-M6-05，FR-13 / R-02）：仅 Host，回包走 kp:metricsResult */
    requestMetrics(sessionId?: string): void {
      if (this.role !== 'host' || !this.activeSessionId) return;
      this.metricsLoading = true;
      getSocket().emit('kp:metrics', sessionId ? { sessionId } : {});
    },

    setAdminToken(token: string): void {
      this.adminToken = token.trim();
      writeAdminToken(this.adminToken);
    },

    /** 会话列表（GET /rooms/{id}/sessions）：管理面，需令牌 */
    async loadSessions(): Promise<void> {
      if (!this.roomId) return;
      this.sessionsLoading = true;
      try {
        this.sessions = await adminRequest<Session[]>(`/rooms/${this.roomId}/sessions`, 'GET');
      } catch (error) {
        this.error = messageOf(error);
      } finally {
        this.sessionsLoading = false;
      }
    },

    /** 结束会话（POST .../end）；结束的是活跃会话时服务端会清空 activeSessionId */
    async endSession(sessionId: string): Promise<void> {
      if (!this.roomId) return;
      try {
        await adminRequest<Session>(`/rooms/${this.roomId}/sessions/${sessionId}/end`, 'POST');
        if (this.activeSessionId === sessionId) this.activeSessionId = null;
        await this.loadSessions();
      } catch (error) {
        this.error = messageOf(error);
      }
    },

    /** 切换活跃会话（PUT /rooms/{id}/active-session，FR-11 连载复播） */
    async activateSession(sessionId: string): Promise<void> {
      if (!this.roomId) return;
      try {
        await adminRequest<Session>(`/rooms/${this.roomId}/active-session`, 'PUT', { sessionId });
        this.activeSessionId = sessionId;
      } catch (error) {
        this.error = messageOf(error);
      }
    },

    /** 会话运行时设置（PATCH .../settings）：写回 session.json，下一次 AI 调用即生效 */
    async saveSessionSettings(sessionId: string, patch: SessionSettingsPatch): Promise<boolean> {
      if (!this.roomId || Object.keys(patch).length === 0) return false;
      try {
        const updated = await adminRequest<Session>(
          `/rooms/${this.roomId}/sessions/${sessionId}/settings`,
          'PATCH',
          patch,
        );
        const index = this.sessions.findIndex((s) => s.id === updated.id);
        if (index >= 0) this.sessions[index] = updated;
        else this.sessions.push(updated);
        return true;
      } catch (error) {
        this.error = messageOf(error);
        return false;
      }
    },

    /** KP 叙事流式增量（T-M3-08）：同触发源追加，换 seq 重开占位（AI 回合房间级串行，同时至多一段） */
    appendNarrationDelta(seq: number, delta: string): void {
      if (this.streaming?.seq !== seq) {
        this.streaming = { seq, content: delta };
        return;
      }
      this.streaming.content += delta;
    },

    /** 叙事收尾（T-M3-08）：完整消息已随 msg:broadcast 落入时间线，清占位 */
    finishNarration(): void {
      this.streaming = null;
    },

    ingest(list: Message[]): void {
      for (const msg of list) {
        if (msg.seq <= this.maxSeq) continue; // 补发与实时流可能重叠，按 seq 去重
        this.messages.push(msg);
        this.maxSeq = msg.seq;
        if (msg.type === 'system' && msg.subtype === 'join' && !msg.content.startsWith(this.name)) {
          // 名册变更以服务端 join ack 为准，这里仅触发一次轻量刷新
          void this.refreshMembers();
        }
      }
    },

    async refreshMembers(): Promise<void> {
      if (!this.roomId) return;
      try {
        // 玩家侧端点：免管理令牌，且不下发邀请码（2026-09-25 路由分离）
        const res = await fetch(`/rooms/${this.roomId}/public`);
        if (!res.ok) return;
        const room = (await res.json()) as { activeSessionId?: string | null };
        this.activeSessionId = room.activeSessionId ?? null;
      } catch {
        // 忽略：成员名册以 join ack / 后续提案事件为准
      }
    },

    reset(): void {
      socket?.disconnect();
      socket = null;
      this.$reset();
    },
  },
});

/**
 * 管理面 REST 统一出口（T-M6-04/05）：带上 KP 填的 X-Admin-Token。
 *
 * 前端默认不带令牌（网页端拿不到），所以 401 必须翻译成一句人话，
 * 而不是静默失败让 KP 以为功能坏了；其余错误优先用服务端的 message。
 */
async function adminRequest<T>(
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  body?: unknown,
): Promise<T> {
  const token = readAdminToken();
  const res = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Admin-Token': token } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (res.status === 401) throw new Error(ADMIN_TOKEN_HINT);
  const payload: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new Error(errorMessage(payload, res.status));
  return payload as T;
}

function errorMessage(payload: unknown, status: number): string {
  if (typeof payload === 'object' && payload !== null) {
    const message = (payload as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return `管理面请求失败（${status}）`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '管理面请求失败';
}

function getSocket(): Socket<ServerToClientEvents, ClientToServerEvents> {
  if (socket) return socket;
  const store = useSessionStore();

  socket = io({ auth: { protocol: PROTOCOL_VERSION } });

  socket.on('connect', () => {
    store.connected = true;
    store.streaming = null; // 重连后 lastSeq 补发带来完整叙事，流式占位作废
    if (store.view === 'room' && store.memberId) {
      // 断线重连：重入房并让服务端补发缺口
      socket?.emit(
        'room:join',
        {
          inviteCode: store.inviteCode,
          name: store.name,
          wantRole: 'player',
          memberId: store.memberId,
          ...(store.maxSeq > 0 ? { lastSeq: store.maxSeq } : {}),
        },
        (resp: JoinAck) => {
          if (resp.ok) {
            store.connectionLost = false;
            store.activeSessionId = resp.activeSessionId ?? null;
            store.members = resp.members ?? [];
          }
        },
      );
    }
  });

  socket.on('disconnect', () => {
    store.connected = false;
    if (store.view === 'room') store.connectionLost = true;
  });

  socket.on('msg:broadcast', (payload) => {
    store.ingest([payload.msg]);
  });

  socket.on('narration:delta', ({ seq, delta }) => {
    store.appendNarrationDelta(seq, delta);
  });

  socket.on('narration:done', () => {
    store.finishNarration();
  });

  socket.on('error:app', (payload) => {
    store.error = payload.message ? `[${payload.code}] ${payload.message}` : payload.code;
    store.previewLoading = false;
    store.metricsLoading = false;
  });

  socket.on('kp:promptPreview', (payload) => {
    store.preview = payload.pipeline;
    store.previewLoading = false;
  });

  socket.on('kp:metricsResult', (payload) => {
    store.metrics = payload;
    store.metricsLoading = false;
  });

  socket.on('state:broadcast', (payload) => {
    store.stateBoard = payload.stateBoard;
  });

  return socket;
}
