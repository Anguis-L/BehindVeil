import { defineStore } from 'pinia';
import { io, type Socket } from 'socket.io-client';
import {
  PROTOCOL_VERSION,
  type Member,
  type MemberRole,
  type Message,
  type MsgSendPayload,
  type RoomJoinPayload,
} from '@behindveil/shared';

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
}

interface SessionStartAck {
  ok: boolean;
  session?: { id: string };
  code?: string;
  message?: string;
}

interface ClientToServerEvents {
  'room:join': (payload: RoomJoinPayload, ack: (resp: JoinAck) => void) => void;
  'msg:send': (payload: MsgSendPayload) => void;
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
      };
    },
    ack: (resp: SessionStartAck) => void,
  ) => void;
}

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
          },
        },
        (resp) => {
          if (resp.ok && resp.session) {
            this.activeSessionId = resp.session.id;
          } else {
            this.error = resp.message ?? '开团失败';
          }
        },
      );
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
        const res = await fetch(`/rooms/${this.roomId}`);
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

function getSocket(): Socket<ServerToClientEvents, ClientToServerEvents> {
  if (socket) return socket;
  const store = useSessionStore();

  socket = io({ auth: { protocol: PROTOCOL_VERSION } });

  socket.on('connect', () => {
    store.connected = true;
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

  socket.on('error:app', (payload) => {
    store.error = payload.message ? `[${payload.code}] ${payload.message}` : payload.code;
  });

  return socket;
}
