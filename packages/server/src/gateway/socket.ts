import { Server, type Socket } from 'socket.io';
import {
  CLIENT_EVENT_SCHEMAS,
  PROTOCOL_VERSION,
  SERVER_EVENT_SCHEMAS,
  isClientEvent,
  type ClientEventName,
  type ErrorCode,
  type Member,
  type MemberRole,
  type Message,
  type OocVisibility,
  type ServerEventName,
  type SystemMsgSubtype,
} from '@behindveil/shared';
import type { FastifyInstance } from 'fastify';
import { JsonlStore } from '../adapters/storage/jsonl-store.js';
import type { DataLayout } from '../adapters/storage/layout.js';
import { appendMessage, readMessagesAfter } from '../domain/session/messages.js';
import { addMember, readMembers } from '../domain/session/members.js';
import { findByInviteCode, readRoomFile } from '../domain/session/rooms.js';
import { createSession } from '../domain/session/sessions.js';
import type { MsgSendPayload, RoomJoinPayload, SessionStartPayload } from '@behindveil/shared';

/**
 * Socket.IO 网关（T-M1-03/05/06/07/08，TDD §4/§8）。
 *
 * - 握手：校验协议版本（不一致拒绝连接）；邀请码/满员校验在 room:join 事件（E-ROOM-01）。
 * - 白名单：onAny 统一分发——非白名单事件或非法 payload 直接断连（TDD §8）。
 * - 主链路：msg:send → 校验 → 限速（10 条/30s/人）→ 每房串行队列（seq 分配 → WAP 落盘 →
 *   投递），保证落盘顺序与 seq 顺序一致（T-M1-05 注记）。
 * - OOC 可见性路由（T-M1-06）：all 走房间广播；host/whisper 走定向投递（绝不全房广播）。
 * - 出站自检：所有投递经 SERVER_EVENT_SCHEMAS 校验后才发出（双向 Zod，TC-FR-02-004）。
 * - M2+ 事件（dice:roll/state:update/state:snapshot/ai:invoke/kp:previewPrompt）：
 *   payload 校验通过后暂不处理（未到里程碑不提前实现），到点在 dispatch 落位。
 */

const MSG_RATE_LIMIT = 10;
const MSG_RATE_WINDOW_MS = 30_000;

export interface GatewayDeps {
  layout: DataLayout;
  /** 启动恢复出的各会话 lastSeq：新消息 seq 从这里续（T-M0-04 → T-M1-05） */
  initialSeqs: Map<string, number>;
}

export interface GatewayHandle {
  close(): Promise<void>;
}

interface Presence {
  roomId: string;
  memberId: string;
  name: string;
  role: MemberRole;
}

type Ack = ((result: unknown) => void) | undefined;

interface JoinAck {
  ok: boolean;
  roomId?: string;
  memberId?: string;
  role?: MemberRole;
  activeSessionId?: string | null;
  lastSeq?: number;
  /** 提案增量（openapi 未列）：进房即带回名册 */
  members?: Member[];
  code?: ErrorCode;
  message?: string;
}

/** 串行队列内构造的待持久化消息（seq/ts/sessionId 由队列统一分配） */
type AppendableMessage =
  | { type: 'ic'; senderId: string; content: string }
  | {
      type: 'ooc';
      senderId: string;
      content: string;
      visibility: OocVisibility;
      targetId?: string;
    }
  | { type: 'system'; subtype: SystemMsgSubtype; content: string };

/** 投递范围：room=全房广播；custom=定向 socket 列表（host/whisper 收窄场景） */
type Routing = { mode: 'room' } | { mode: 'custom'; socketIds: Iterable<string> };

export function attachGateway(app: FastifyInstance, deps: GatewayDeps): GatewayHandle {
  const { layout } = deps;
  const io = new Server(app.server);

  const presence = new Map<string, Presence>();
  const roomMembers = new Map<string, Set<string>>();
  const roomHostSockets = new Map<string, Set<string>>();
  const memberSockets = new Map<string, Set<string>>();
  const seqCounters = new Map<string, number>(deps.initialSeqs);
  const roomQueues = new Map<string, Promise<void>>();
  const sendWindows = new Map<string, number[]>();
  const jsonlStores = new Map<string, JsonlStore>();

  app.addHook('onClose', async () => {
    io.disconnectSockets(true);
    io.removeAllListeners();
  });

  // 握手第一关：协议版本（AsyncAPI「握手三校验」之一；邀请码/满员在 room:join 事件校验）
  io.use((socket, next) => {
    const protocol = socket.handshake.auth?.['protocol'];
    if (protocol !== PROTOCOL_VERSION) {
      next(new Error(`protocol-mismatch: 服务端 ${PROTOCOL_VERSION}`));
      return;
    }
    next();
  });

  io.on('connection', (socket) => {
    socket.onAny((event: string, ...args: unknown[]) => {
      // 非白名单事件断连（防伪造事件注入）
      if (!isClientEvent(event)) {
        socket.disconnect(true);
        return;
      }
      const schema = CLIENT_EVENT_SCHEMAS[event as ClientEventName];
      const parsed = schema.safeParse(args[0]);
      if (!parsed.success) {
        // 非法 payload 断连（TDD §8），不回业务错误
        socket.disconnect(true);
        return;
      }
      const ack = typeof args[1] === 'function' ? (args[1] as Ack) : undefined;
      void dispatch(socket, event as ClientEventName, parsed.data, ack).catch((err: unknown) => {
        console.error(`[gateway] 处理 ${event} 失败：`, err);
      });
    });

    socket.on('disconnect', () => {
      void handleDisconnect(socket).catch((err: unknown) => {
        console.error('[gateway] 断开清理失败：', err);
      });
    });
  });

  async function dispatch(
    socket: Socket,
    event: ClientEventName,
    payload: unknown,
    ack: Ack,
  ): Promise<void> {
    switch (event) {
      case 'room:join':
        await handleJoin(socket, payload as RoomJoinPayload, ack);
        return;
      case 'msg:send':
        await handleMsgSend(socket, payload as MsgSendPayload);
        return;
      case 'session:start':
        await handleSessionStart(socket, payload as SessionStartPayload, ack);
        return;
      default:
        return;
    }
  }

  function emitChecked(
    emitter: { emit(event: string, ...args: unknown[]): unknown },
    event: ServerEventName,
    payload: unknown,
  ): void {
    const parsed = SERVER_EVENT_SCHEMAS[event].safeParse(payload);
    if (!parsed.success) {
      console.error(`[gateway] 出站 payload 未通过 Schema 自检（${event}），已拦截`);
      return;
    }
    emitter.emit(event, parsed.data);
  }

  function emitError(socket: Socket, code: ErrorCode, message: string): void {
    emitChecked(socket, 'error:app', { code, message });
  }

  function enqueue(roomId: string, task: () => Promise<void>): Promise<void> {
    const previous = roomQueues.get(roomId) ?? Promise.resolve();
    const next = previous.then(task, task); // 前序失败不阻塞后续消息
    roomQueues.set(
      roomId,
      next.catch(() => undefined),
    );
    return next;
  }

  function storeFor(roomId: string, sessionId: string): JsonlStore {
    const key = `${roomId}:${sessionId}`;
    let store = jsonlStores.get(key);
    if (!store) {
      store = new JsonlStore(layout.messagesFile(roomId, sessionId));
      jsonlStores.set(key, store);
    }
    return store;
  }

  function buildMessage(sessionId: string, appendable: AppendableMessage, seq: number): Message {
    const ts = new Date().toISOString();
    const base = { seq, ts, sessionId };
    switch (appendable.type) {
      case 'ic':
        return { ...base, type: 'ic', senderId: appendable.senderId, content: appendable.content };
      case 'ooc':
        return {
          ...base,
          type: 'ooc',
          senderId: appendable.senderId,
          content: appendable.content,
          visibility: appendable.visibility,
          ...(appendable.targetId ? { targetId: appendable.targetId } : {}),
        };
      case 'system':
        return {
          ...base,
          type: 'system',
          subtype: appendable.subtype,
          content: appendable.content,
        };
    }
  }

  /** 在串行队列内：分配 seq → WAP 落盘 → 按路由投递（T-M1-05 主链路）；缺省全房广播 */
  async function persistAndDeliver(
    roomId: string,
    sessionId: string,
    appendable: AppendableMessage,
    routing: Routing = { mode: 'room' },
  ): Promise<void> {
    const seq = (seqCounters.get(sessionId) ?? 0) + 1;
    const message = buildMessage(sessionId, appendable, seq);
    await appendMessage(layout, roomId, sessionId, message, storeFor(roomId, sessionId));
    seqCounters.set(sessionId, seq);

    const payload = { msg: message };
    if (routing.mode === 'room') {
      emitChecked(io.to(`room:${roomId}`), 'msg:broadcast', payload);
      return;
    }
    for (const socketId of routing.socketIds) {
      emitChecked(io.to(socketId), 'msg:broadcast', payload);
    }
  }

  async function handleJoin(socket: Socket, data: RoomJoinPayload, ack: Ack): Promise<void> {
    const respond = (result: JoinAck): void => ack?.(result);

    const roomFile = await findByInviteCode(layout, data.inviteCode);
    if (!roomFile) {
      emitError(socket, 'E-ROOM-01', '邀请码无效');
      respond({ ok: false, code: 'E-ROOM-01', message: '邀请码无效' });
      return;
    }

    const onlineIds = roomMembers.get(roomFile.id) ?? new Set<string>();
    if (onlineIds.size >= roomFile.memberLimit && !onlineIds.has(data.memberId ?? '')) {
      emitError(socket, 'E-ROOM-01', '房间已满');
      respond({ ok: false, code: 'E-ROOM-01', message: '房间已满' });
      return;
    }

    // 开放问题①默认方案：建房者以 hostToken 证明 Host 身份（D-02：Host 不可申请）
    const role: MemberRole =
      data.hostToken !== undefined && data.hostToken === roomFile.hostToken
        ? 'host'
        : data.wantRole;

    let member: Member | null = data.memberId
      ? await findExistingMember(roomFile.id, data.memberId)
      : null;
    if (member && member.role === 'host' && role !== 'host') {
      // Host 身份重连必须出示 hostToken，防止凭 memberId 冒领
      member = null;
    }
    if (!member) {
      member = await addMember(layout, roomFile.id, { name: data.name, role });
    }

    presence.set(socket.id, {
      roomId: roomFile.id,
      memberId: member.id,
      name: member.name,
      role,
    });
    onlineIds.add(member.id);
    roomMembers.set(roomFile.id, onlineIds);
    const sockets = memberSockets.get(member.id) ?? new Set<string>();
    sockets.add(socket.id);
    memberSockets.set(member.id, sockets);
    if (role === 'host') {
      const hosts = roomHostSockets.get(roomFile.id) ?? new Set<string>();
      hosts.add(socket.id);
      roomHostSockets.set(roomFile.id, hosts);
    }
    socket.join(`room:${roomFile.id}`);

    const activeSessionId = roomFile.activeSessionId;
    const lastSeq = activeSessionId ? (seqCounters.get(activeSessionId) ?? 0) : 0;

    if (activeSessionId) {
      const name = member.name;
      await enqueue(roomFile.id, () =>
        persistAndDeliver(roomFile.id, activeSessionId, {
          type: 'system',
          subtype: 'join',
          content: `${name} 加入了房间`,
        }),
      );
    }

    respond({
      ok: true,
      roomId: roomFile.id,
      memberId: member.id,
      role,
      activeSessionId,
      lastSeq,
      // 提案增量（openapi 未列）：进房即带回名册，供前端成员栏渲染
      members: await readMembers(layout, roomFile.id),
    });

    // 断线补发（T-M1-08）：seq > lastSeq 的消息按升序回放给本连接
    if (data.lastSeq !== undefined && activeSessionId) {
      const missed = await readMessagesAfter(
        layout,
        roomFile.id,
        activeSessionId,
        data.lastSeq,
        storeFor(roomFile.id, activeSessionId),
      );
      for (const message of missed) emitChecked(socket, 'msg:broadcast', { msg: message });
    }
  }

  async function findExistingMember(roomId: string, memberId: string): Promise<Member | null> {
    const members = await readMembers(layout, roomId);
    return members.find((m) => m.id === memberId) ?? null;
  }

  async function handleMsgSend(socket: Socket, data: MsgSendPayload): Promise<void> {
    const me = presence.get(socket.id);
    if (!me) {
      emitError(socket, 'E-ROOM-01', '尚未加入房间');
      return;
    }
    if (me.role === 'observer') {
      // TDD §4.1：msg:send 权限 player+；观察者 v1 不可发言（错误码语义待评审细化）
      emitError(socket, 'E-ROOM-01', '观察者视角不能发言');
      return;
    }

    // 限速：10 条 / 30 秒 / 人，滑动窗口
    const now = Date.now();
    const window = (sendWindows.get(me.memberId) ?? []).filter((t) => now - t < MSG_RATE_WINDOW_MS);
    if (window.length >= MSG_RATE_LIMIT) {
      emitError(socket, 'E-ROOM-01', '发送太频繁，请稍后再试');
      sendWindows.set(me.memberId, window);
      return;
    }
    window.push(now);
    sendWindows.set(me.memberId, window);

    const room = await readRoomFile(layout, me.roomId);
    const sessionId = room?.activeSessionId;
    if (!room || !sessionId) {
      emitError(socket, 'E-ROOM-01', '尚未开团，暂不能发言');
      return;
    }

    // OOC 可见性路由（T-M1-06）：收窄场景绝不走全房广播
    let routing: Routing = { mode: 'room' };
    let appendable: AppendableMessage;
    if (data.type === 'ic') {
      appendable = { type: 'ic', senderId: me.memberId, content: data.content };
    } else if (data.targetId) {
      const recipients = new Set<string>([
        ...(memberSockets.get(data.targetId) ?? []),
        ...(roomHostSockets.get(me.roomId) ?? []),
        ...(memberSockets.get(me.memberId) ?? []),
      ]);
      routing = { mode: 'custom', socketIds: recipients };
      appendable = {
        type: 'ooc',
        senderId: me.memberId,
        content: data.content,
        visibility: 'whisper',
        targetId: data.targetId,
      };
    } else if (data.visibility === 'host') {
      const recipients = new Set<string>([
        ...(roomHostSockets.get(me.roomId) ?? []),
        ...(memberSockets.get(me.memberId) ?? []),
      ]);
      routing = { mode: 'custom', socketIds: recipients };
      appendable = {
        type: 'ooc',
        senderId: me.memberId,
        content: data.content,
        visibility: 'host',
      };
    } else {
      appendable = {
        type: 'ooc',
        senderId: me.memberId,
        content: data.content,
        visibility: 'all',
      };
    }

    await enqueue(me.roomId, () => persistAndDeliver(me.roomId, sessionId, appendable, routing));
  }

  async function handleSessionStart(
    socket: Socket,
    data: SessionStartPayload,
    ack: Ack,
  ): Promise<void> {
    const me = presence.get(socket.id);
    if (!me) {
      emitError(socket, 'E-ROOM-01', '尚未加入房间');
      ack?.({ ok: false, code: 'E-ROOM-01', message: '尚未加入房间' });
      return;
    }
    if (me.role !== 'host') {
      emitError(socket, 'E-ROOM-01', '仅 Host 可开团');
      ack?.({ ok: false, code: 'E-ROOM-01', message: '仅 Host 可开团' });
      return;
    }
    const session = await createSession(layout, me.roomId, {
      moduleId: data.moduleId,
      settings: data.settings,
    });
    seqCounters.set(session.id, 0);
    await enqueue(me.roomId, () =>
      persistAndDeliver(me.roomId, session.id, {
        type: 'system',
        subtype: 'notice',
        content: `会话已开始（${data.moduleId}）`,
      }),
    );
    ack?.({ ok: true, session });
  }

  async function handleDisconnect(socket: Socket): Promise<void> {
    const me = presence.get(socket.id);
    if (!me) return;
    presence.delete(socket.id);

    const sockets = memberSockets.get(me.memberId);
    if (sockets) {
      sockets.delete(socket.id);
      if (sockets.size === 0) memberSockets.delete(me.memberId);
      else return; // 同一成员还有其他连接在线，不算离开
    }

    const online = roomMembers.get(me.roomId);
    if (online) {
      online.delete(me.memberId);
      if (online.size === 0) roomMembers.delete(me.roomId);
    }
    const hosts = roomHostSockets.get(me.roomId);
    if (hosts) {
      hosts.delete(socket.id);
      if (hosts.size === 0) roomHostSockets.delete(me.roomId);
    }

    const room = await readRoomFile(layout, me.roomId);
    const sessionId = room?.activeSessionId;
    if (sessionId) {
      const name = me.name;
      await enqueue(me.roomId, () =>
        persistAndDeliver(me.roomId, sessionId, {
          type: 'system',
          subtype: 'leave',
          content: `${name} 离开了房间`,
        }),
      );
    }
  }

  return {
    async close(): Promise<void> {
      io.disconnectSockets(true);
      io.removeAllListeners();
    },
  };
}
