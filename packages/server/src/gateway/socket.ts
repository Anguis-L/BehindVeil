import { appendFile, mkdir } from 'node:fs/promises';
import { Server, type Socket } from 'socket.io';
import {
  CLIENT_EVENT_SCHEMAS,
  PROTOCOL_VERSION,
  SERVER_EVENT_SCHEMAS,
  isClientEvent,
  readCardExtensions,
  type ClientEventName,
  type ErrorCode,
  type KpMetricsPayload,
  type KpPreviewPromptPayload,
  type Member,
  type MemberRole,
  type Message,
  type OocVisibility,
  type GenericRule,
  type RollResult,
  type ServerEventName,
  type Session,
  type SynopsisConfirmPayload,
  type SynopsisDismissPayload,
  type SystemMsgSubtype,
} from '@behindveil/shared';
import type { FastifyInstance } from 'fastify';
import { JsonlStore } from '../adapters/storage/jsonl-store.js';
import type { DataLayout } from '../adapters/storage/layout.js';
import type { ParsedRoll } from '../domain/dice/evaluator.js';
import { rollDice } from '../domain/dice/evaluator.js';
import { DiceExpressionError } from '../domain/dice/parser.js';
import { createCsprngRandom } from '../domain/dice/random.js';
import { createDiceAuditor } from '../domain/dice/audit.js';
import { createRuleBook, ruleBookIdOf } from '../domain/rulebook/index.js';
import { createGenericRuleBook } from '../domain/rulebook/generic.js';
import type { RuleBook } from '../domain/rulebook/types.js';
import { DirectiveSuccessTracker } from '../domain/ai-directive/degrade.js';
import type { DirectiveScanEvent } from '../domain/ai-directive/scan.js';
import { runAiTurn } from '../domain/ai-directive/loop.js';
import type { LlmAdapter } from '../domain/llm.js';
import { applyStatePatch, readStateBoard, saveStateBoard } from '../domain/stateboard/board.js';
import { hpPatch, resourcePatch, sanityLossPatch } from '../domain/stateboard/engine-writes.js';
import { createStateBoardRoster } from '../domain/stateboard/roster.js';
import { loadModule } from '../domain/module/library.js';
import { appendMessage, readMessagesAfter } from '../domain/session/messages.js';
import { addMember, readMembers, updateMemberRole } from '../domain/session/members.js';
import { generateHostToken } from '../domain/session/ids.js';
import { findByInviteCode, readRoomFile, saveRoomFile } from '../domain/session/rooms.js';
import { createSession, readSession, updateSynopsis } from '../domain/session/sessions.js';
import { dismissProposal, proposeSynopsis } from '../domain/session/synopsis.js';
import { GlobalIndex, indexEntryOf } from '../observability/global-index.js';
import { buildPreviewTrace, type RecallContext } from '../observability/preview.js';
import { MetricsCollector } from '../observability/metrics.js';
import type {
  DiceRollPayload,
  MsgSendPayload,
  RoomJoinPayload,
  SessionStartPayload,
  StateBoard,
  StateUpdatePayload,
} from '@behindveil/shared';

/**
 * Socket.IO 网关（T-M1-03/05/06/07/08 + T-M3-06，TDD §4/§8/§5.4）。
 *
 * - 握手：校验协议版本（不一致拒绝连接）；邀请码/满员校验在 room:join 事件（E-ROOM-01）。
 * - 白名单：onAny 统一分发——非白名单事件或非法 payload 直接断连（TDD §8）。
 * - 主链路：msg:send → 校验 → 限速（10 条/30s/人）→ 每房串行队列（seq 分配 → WAP 落盘 →
 *   投递），保证落盘顺序与 seq 顺序一致（T-M1-05 注记）。
 * - OOC 可见性路由（T-M1-06）：all 走房间广播；host/whisper 走定向投递（绝不全房广播）。
 * - 出站自检：所有投递经 SERVER_EVENT_SCHEMAS 校验后才发出（双向 Zod，TC-FR-02-004）。
 * - KP prompt 预览（T-M2-05，FR-13）：kp:previewPrompt → host only → kp:promptPreview 定向回包。
 * - AI 触发（T-M3-06，D-07）：玩家 IC 自动触发 + ai:invoke 显式触发（每人每轮 1 次，
 *   「轮」= 相邻两次 AI 回合之间的窗口）；AI 回合独立串行队列，不阻塞消息主链路。
 * - 玩家骰（T-M4-02/03，FR-06/14）：dice:roll → 解析 → 掷骰 → 落审计 → 广播；
 *   暗骰按决议 D-10 仅投递 Host 与掷骰者；非法骰式回 E-DICE-01（行内提示，不广播）。
 * - 状态板写路径（T-M5-06，FR-09）：state:update → 仅 Host → 房间队列内乐观锁校验
 *   （E-ST-01 拒绝并广播最新版）→ 原子落盘 → state:broadcast 全员广播。
 *   状态板内存态按会话懒加载，检定名册（T-M5-04）同步读内存板。
 * - 快照机制（T-M5-07，SDD §5.4）：state:snapshot（Host）→ SnapshotMsg 入流
 *   （WAP 落盘 + 全房广播）；每 N=20 条消息追加提醒 notice，由 Host 确认生成。
 * - 指标埋点（T-M6-03/05，FR-13 / R-01 / R-02，TDD §9）：LLM 调用（耗时 / usage / 失败）
 *   与掷骰（总数 / 暗骰）记入进程内收集器；`kp:metrics`（Host）回本会话实时指标
 *   ——前端不带管理令牌，拿不到 `GET /metrics`，房内只能走这条。
 */

const MSG_RATE_LIMIT = 10;
const MSG_RATE_WINDOW_MS = 30_000;

/** 快照提醒周期（T-M5-07，SDD §5.4：每 N=20 条消息提醒 Host 确认生成快照） */
const SNAPSHOT_REMINDER_EVERY = 20;

/**
 * 会话规则书（T-M7-04）：按会话落盘的规则书标识装配（缺省 coc7，v1 存量数据无该字段）。
 * coc7/dnd5e 无状态随用随建；generic 的编译闭包按配置缓存，配置快照来自会话记录
 * （开团时自 KP 卡冻结，v3 FR-40）。
 */
function sessionRuleBook(session: Session | null): RuleBook {
  return createRuleBook(ruleBookIdOf(session?.rulebook), {
    nat20Rule: session?.settings.nat20Rule,
    genericRule: session?.genericRule,
  });
}

export interface GatewayDeps {
  layout: DataLayout;
  /** 启动恢复出的各会话 lastSeq：新消息 seq 从这里续（T-M0-04 → T-M1-05） */
  initialSeqs: Map<string, number>;
  /** LLM 适配器（装配根按配置产出；缺省/失败为 undefined → AI 触发不生效） */
  llm?: LlmAdapter;
  /** ChatRequest 参数（model/maxTokens 来自 config，temperature 装配侧定） */
  chat?: { model: string; temperature: number; maxTokens: number };
  /**
   * 进程内指标收集器（T-M6-03）：装配根传入以与 `GET /metrics` 共用同一实例；
   * 缺省时网关自建一个（房内 `kp:metrics` 仍可用，只是不进全局端点）。
   */
  metrics?: MetricsCollector;
  /**
   * 向量召回上下文（v3 T-M11-03，FR-33）：llm.embedding 配置且装配成功才有。
   * 缺省 = 向量召回关闭（S3.5 跳过，行为与 v2.0 逐字节一致）。
   */
  recall?: RecallContext;
  /**
   * 跨房间全局消息索引（v3 T-M11-05，FR-34）：消息落盘同批追加一份索引行。
   * 注入口供测试对拍；缺省网关自建（写 `data/index/global.jsonl`）。
   * 传 false 显式关闭（索引是纯增益，关闭不影响任何主链路行为）。
   */
  globalIndex?: GlobalIndex | false;
}

export interface GatewayHandle {
  close(): Promise<void>;
  /**
   * 指令协议全程累计统计（T-M3-07，R-01）。汇总所有会话 tracker 的累计口径，
   * 供 50 轮回归（TC-FR-05-011）与后续 /metrics 取用；滑动窗口仍在各自 tracker 内。
   */
  directiveStats(): { attempts: number; successes: number; rate: number };
  /** Host 转让（T-M8-06，FR-26）：REST 管理面路由经此进入网关（在线状态/presence 在网关内存态） */
  transferHost(
    roomId: string,
    hostToken: string,
    toMemberId: string,
  ): Promise<{ ok: true; memberId: string } | { ok: false; code: ErrorCode; message: string }>;
  /** 副 Host 设置（memberId=null 为撤销） */
  setCoHost(
    roomId: string,
    hostToken: string,
    memberId: string | null,
  ): Promise<{ ok: true } | { ok: false; code: ErrorCode; message: string }>;
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
  | { type: 'system'; subtype: SystemMsgSubtype; content: string }
  | { type: 'dice'; roll: RollResult; hidden: boolean; senderId?: string }
  | { type: 'narration'; content: string }
  | { type: 'state_snapshot'; stateBoard: StateBoard };

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
  const roomQueues = new Map<string, Promise<unknown>>();
  /** AI 回合独立串行队列（D-07：AI 忙时排队串行，不阻塞消息主链路） */
  const aiQueues = new Map<string, Promise<unknown>>();
  /** 「轮」计数（D-07）：每完成一个 AI 回合 +1；ai:invoke 配额按轮判定 */
  const aiRounds = new Map<string, number>();
  /** 成员最近一次 ai:invoke 所在轮（同一轮再次调用被限流，TC-FR-05-010） */
  const memberInvokeRound = new Map<string, Map<string, number>>();
  /** R-01 滑动窗口（T-M3-05）：挂在会话上，跨 AI 回合累计 */
  const trackers = new Map<string, DirectiveSuccessTracker>();
  const sendWindows = new Map<string, number[]>();
  const jsonlStores = new Map<string, JsonlStore>();
  /**
   * 状态板内存态（T-M5-06）：key = sessionId，首次访问从 state.json 懒加载，
   * 写路径在房间队列内同步维护。检定名册（createStateBoardRoster）按会话读此板，
   * PcRoster 端口保持同步签名。
   */
  const stateBoards = new Map<string, StateBoard>();
  /** 骰子审计流水（T-M4-01）：所有掷骰先落审计再广播 */
  const auditor = createDiceAuditor(layout);
  const random = createCsprngRandom();
  /** 指标收集器（T-M6-03）：与装配根共用实例，缺省自建（见 GatewayDeps.metrics） */
  const metrics = deps.metrics ?? new MetricsCollector();
  /** 跨房间全局索引（T-M11-05，FR-34）：false = 显式关闭 */
  const globalIndex =
    deps.globalIndex === false
      ? null
      : (deps.globalIndex ?? new GlobalIndex(layout.globalIndexFile));

  app.addHook('onClose', async () => {
    io.disconnectSockets(true);
    io.removeAllListeners();
    // 索引句柄**不在关服时主动关闭**：关服瞬间可能有在途的 append 正握着它，
    // 主动 close 会让那次追加抛「file closed」并刷一行无意义的告警。
    // 索引是追加型派生数据（损坏可重建），句柄交给进程退出时回收即可。
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
        // TC-FR-02-001 故障变体：写盘失败等内部错误 → 该消息不广播（落盘后才广播），
        // 并回业务错误让客户端可感知（2026-09-25 拍板：新增 E-SRV-01）
        emitError(socket, 'E-SRV-01', '服务器开小差了，请稍后重试');
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
      case 'kp:previewPrompt':
        await handlePreviewPrompt(socket, payload as KpPreviewPromptPayload);
        return;
      case 'kp:metrics':
        await handleMetrics(socket, payload as KpMetricsPayload);
        return;
      case 'ai:invoke':
        await handleAiInvoke(socket);
        return;
      case 'dice:roll':
        await handleDiceRoll(socket, payload as DiceRollPayload);
        return;
      case 'state:update':
        await handleStateUpdate(socket, payload as StateUpdatePayload);
        return;
      case 'state:snapshot':
        await handleStateSnapshot(socket);
        return;
      case 'synopsis:confirm':
        await handleSynopsisConfirm(socket, payload as SynopsisConfirmPayload, ack);
        return;
      case 'synopsis:dismiss':
        await handleSynopsisDismiss(socket, payload as SynopsisDismissPayload, ack);
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

  function emitError(
    emitter: { emit(event: string, ...args: unknown[]): unknown },
    code: ErrorCode,
    message: string,
  ): void {
    emitChecked(emitter, 'error:app', { code, message });
  }

  /**
   * 房间状态快照推送（room:sync，2026-10-07 GUI 真人调试修复）：成员进离/开团等
   * 房间级变更此前只以 system 消息入流，已连接客户端的成员栏与「尚未开团」态
   * 不随之刷新。join / leave / session:start / Host 转让四个生命周期点调用，
   * 客户端以 payload 为准整体覆盖成员栏与活跃会话。
   */
  async function emitRoomSync(roomId: string): Promise<void> {
    const [room, members] = await Promise.all([
      readRoomFile(layout, roomId),
      readMembers(layout, roomId),
    ]);
    emitChecked(io.to(`room:${roomId}`), 'room:sync', {
      members,
      activeSessionId: room?.activeSessionId ?? null,
    });
  }

  function enqueue<T>(roomId: string, task: () => Promise<T>): Promise<T> {
    const previous = roomQueues.get(roomId) ?? Promise.resolve();
    const next = previous.then(task, task); // 前序失败不阻塞后续消息
    roomQueues.set(
      roomId,
      next.catch(() => undefined),
    );
    return next;
  }

  /** AI 回合串行队列（与消息队列分离：LLM 生成期间玩家消息照常收发，D-07） */
  function enqueueAi(roomId: string, task: () => Promise<void>): Promise<void> {
    const previous = aiQueues.get(roomId) ?? Promise.resolve();
    const next = previous.then(task, task);
    aiQueues.set(
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

  /** 状态板内存态懒加载（T-M5-06）；须在房间队列内调用以与写路径串行 */
  async function boardFor(roomId: string, sessionId: string): Promise<StateBoard> {
    let board = stateBoards.get(sessionId);
    if (!board) {
      board = await readStateBoard(layout, roomId, sessionId);
      stateBoards.set(sessionId, board);
    }
    return board;
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
      case 'dice':
        return {
          ...base,
          type: 'dice',
          roll: appendable.roll,
          hidden: appendable.hidden,
          ...(appendable.senderId ? { senderId: appendable.senderId } : {}),
        };
      case 'narration':
        return { ...base, type: 'narration', streaming: false, content: appendable.content };
      case 'state_snapshot':
        return { ...base, type: 'state_snapshot', stateBoard: appendable.stateBoard };
    }
  }

  /** 在串行队列内：分配 seq → WAP 落盘 → 按路由投递（T-M1-05 主链路）；缺省全房广播。返回落盘 seq */
  async function persistAndDeliver(
    roomId: string,
    sessionId: string,
    appendable: AppendableMessage,
    routing: Routing = { mode: 'room' },
  ): Promise<number> {
    const seq = (seqCounters.get(sessionId) ?? 0) + 1;
    const message = buildMessage(sessionId, appendable, seq);
    await appendMessage(layout, roomId, sessionId, message, storeFor(roomId, sessionId));
    seqCounters.set(sessionId, seq);

    // 全局索引同批追加（FR-34）：与消息落盘同一队列操作，零新增写路径。
    // 索引是纯增益（损坏可 aidle-reindex 重建），失败只告警、绝不阻断主链路。
    if (globalIndex) {
      try {
        await globalIndex.append(indexEntryOf(roomId, sessionId, message));
      } catch (err) {
        console.warn(
          `[gateway] 全局索引追加失败（可用 aidle-reindex 重建）：${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    const payload = { msg: message };
    if (routing.mode === 'room') {
      emitChecked(io.to(`room:${roomId}`), 'msg:broadcast', payload);
    } else {
      for (const socketId of routing.socketIds) {
        emitChecked(io.to(socketId), 'msg:broadcast', payload);
      }
    }

    // 快照提醒（T-M5-07，TC-FR-09-005）：每 N=20 条消息追加一条 notice。
    // 提醒自身占 seq=N+1（N%20=0 时 N+1 不再命中周期），无连锁递归。
    if (seq % SNAPSHOT_REMINDER_EVERY === 0) {
      await persistAndDeliver(roomId, sessionId, {
        type: 'system',
        subtype: 'notice',
        content: `本会话已达 ${seq} 条消息，KP 可确认生成状态板快照（state:snapshot）`,
      });
    }
    return seq;
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

    // 开放问题①默认方案：建房者以 hostToken 证明 Host 身份（D-02：Host 不可申请）。
    // T-M8-06 转让后（hostAuth='member'）：Host 身份锚定 members.json 角色标记，
    // 凭 memberId 恢复（memberId 与 hostToken 同为客户端持有凭据，泄露面等价；旧 token 已轮换失效）。
    let member: Member | null = data.memberId
      ? await findExistingMember(roomFile.id, data.memberId)
      : null;
    const tokenHost = data.hostToken !== undefined && data.hostToken === roomFile.hostToken;
    const memberHost = roomFile.hostAuth === 'member' && member?.role === 'host';
    const role: MemberRole = tokenHost || memberHost ? 'host' : data.wantRole;

    if (member && member.role === 'host' && role !== 'host') {
      // Host 身份重连必须出示 hostToken，防止凭 memberId 冒领（hostAuth='token' 口径不变）
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

    // 房间状态推送（room:sync）：名册变更必须到达**已在线**的客户端——
    // join ack 只覆盖新进者，此前后进成员对先在线者不可见（成员栏/声明 PC 下拉全滞留）
    await emitRoomSync(roomFile.id);

    // 断线补发（T-M1-08）：seq > lastSeq 的消息按升序回放给本连接
    if (data.lastSeq !== undefined && activeSessionId) {
      // 补发按本连接身份过滤（FR-14 / D-10）：不给旁人补暗骰与密语
      const missed = await readMessagesAfter(
        layout,
        roomFile.id,
        activeSessionId,
        data.lastSeq,
        { memberId: member.id, role },
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

    const seq = await enqueue(me.roomId, () =>
      persistAndDeliver(me.roomId, sessionId, appendable, routing),
    );
    // AI 自动触发（D-07）：仅 IC 消息触发，OOC 不触发；LLM 未装配时为 no-op
    if (data.type === 'ic' && deps.llm && deps.chat) {
      scheduleAiTurn(me.roomId, sessionId, seq);
    }
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
    // 模组校验（T-M5-05，TC-FR-10-001）：manifest + 三件套不通过即拒绝开团（E-MOD-01），
    // init-state 随 createSession 合入状态板初始值（TC-FR-10-003）
    const loaded = await loadModule(layout, data.moduleId);
    if (!loaded.ok) {
      emitError(socket, 'E-MOD-01', `模组无法装载：${loaded.message}`);
      ack?.({ ok: false, code: 'E-MOD-01', message: `模组无法装载：${loaded.message}` });
      return;
    }
    // 规则书选择（T-M7-04，设计 v2 §5.1）：KP 卡 rulebook 优先，回退 manifest，缺省 coc7
    const extensions = readCardExtensions(loaded.module.kpCard);
    const rulebook = ruleBookIdOf(extensions.rulebook ?? loaded.module.manifest.rulebook);
    // generic 配置（v3 FR-40 / ADR-3-08）：自 KP 卡取，装载时编译校验——
    // 坏配置（骰式不合法 / when 文法外）开团即拒 E-MOD-01，不带病进会话
    let genericRule: GenericRule | undefined;
    if (rulebook === 'generic') {
      if (!extensions.genericRule) {
        const message = 'KP 卡 rulebook 为 generic 但缺 genericRule 配置';
        emitError(socket, 'E-MOD-01', `模组无法装载：${message}`);
        ack?.({ ok: false, code: 'E-MOD-01', message: `模组无法装载：${message}` });
        return;
      }
      try {
        createGenericRuleBook(extensions.genericRule);
      } catch (err) {
        const message = err instanceof RangeError ? err.message : String(err);
        emitError(socket, 'E-MOD-01', `模组无法装载：${message}`);
        ack?.({ ok: false, code: 'E-MOD-01', message: `模组无法装载：${message}` });
        return;
      }
      genericRule = extensions.genericRule;
    }
    // 一房一规则书：本房已有活跃会话且规则书不同 → 拒绝开团（防混合态）
    const room = await readRoomFile(layout, me.roomId);
    const current = room?.activeSessionId
      ? await readSession(layout, me.roomId, room.activeSessionId)
      : null;
    if (current && current.endedAt === null && ruleBookIdOf(current.rulebook) !== rulebook) {
      const message = `本房当前会话使用 ${ruleBookIdOf(current.rulebook)} 规则，无法切换为 ${rulebook}（一房一规则书）`;
      emitError(socket, 'E-MOD-01', message);
      ack?.({ ok: false, code: 'E-MOD-01', message });
      return;
    }

    const session = await createSession(layout, me.roomId, {
      moduleId: data.moduleId,
      settings: data.settings,
      initState: loaded.module.initState,
      rulebook,
      genericRule,
    });
    seqCounters.set(session.id, 0);
    await enqueue(me.roomId, () =>
      persistAndDeliver(me.roomId, session.id, {
        type: 'system',
        subtype: 'notice',
        content: `会话已开始（${data.moduleId}）`,
      }),
    );
    // room:sync：已在线客户端的「尚未开团」态与状态板有效性必须随开团刷新——
    // system 消息不承载会话状态，玩家端此前只能刷新重进才能解锁输入
    await emitRoomSync(me.roomId);
    ack?.({ ok: true, session });
  }

  /**
   * 掷骰落账（T-M4-01/02）：先写审计流水（WAP 同侧，record 返回即已 fsync），
   * 再交给消息主链路广播——无审计号的骰子进不了消息流（出站 Schema 自检会拦下）。
   */
  async function recordDice(
    roomId: string,
    sessionId: string,
    roll: ParsedRoll,
    meta: { hidden: boolean; senderId?: string },
  ): Promise<RollResult> {
    // 指标埋点（T-M6-03）：玩家骰与 AI 检定骰共用本入口，一次记全（暗骰单独计数）
    metrics.recordDice(sessionId, meta.hidden);
    const audit = await auditor.record({
      roomId,
      sessionId,
      actor: meta.senderId ?? null,
      hidden: meta.hidden,
      expr: roll.expr,
      rolls: roll.rolls,
      kept: roll.kept,
      total: roll.total,
      check: roll.check,
    });
    return {
      expr: roll.expr,
      rolls: roll.rolls,
      kept: roll.kept,
      total: roll.total,
      ...(roll.check ? { check: roll.check } : {}),
      audit,
    };
  }

  /**
   * 玩家骰（T-M4-02/03，FR-06/14）：dice:roll → 解析 → 掷骰 → 落审计 → 广播。
   * 暗骰按决议 D-10 只投 Host 与掷骰者本人；非法骰式回 E-DICE-01 行内提示
   * （不广播、不占 seq、不进审计——压根没掷出骰子）。
   */
  async function handleDiceRoll(socket: Socket, data: DiceRollPayload): Promise<void> {
    const me = presence.get(socket.id);
    if (!me) {
      emitError(socket, 'E-ROOM-01', '尚未加入房间');
      return;
    }
    if (me.role === 'observer') {
      emitError(socket, 'E-ROOM-01', '旁观视角不能掷骰');
      return;
    }
    const room = await readRoomFile(layout, me.roomId);
    const sessionId = room?.activeSessionId;
    if (!room || !sessionId) {
      emitError(socket, 'E-ROOM-01', '尚未开团，暂不能掷骰');
      return;
    }

    // 规则书与默认判定种类随会话走（T-M7-04）：5e 房的手掷骰按属性检定判定
    const session = await readSession(layout, me.roomId, sessionId);
    const rulebook = sessionRuleBook(session);

    let roll: ParsedRoll;
    try {
      roll = rollDice(data.expr, { random, rulebook, kind: rulebook.defaultKind });
    } catch (err) {
      if (err instanceof DiceExpressionError) {
        emitError(socket, 'E-DICE-01', `${err.message}。${err.help}`);
        return;
      }
      throw err;
    }

    const hidden = data.hidden === true;
    // 暗骰收窄投递：Host + 掷骰者本人（D-10）
    const routing: Routing = hidden
      ? {
          mode: 'custom',
          socketIds: new Set<string>([
            ...(roomHostSockets.get(me.roomId) ?? []),
            ...(memberSockets.get(me.memberId) ?? []),
          ]),
        }
      : { mode: 'room' };

    await enqueue(me.roomId, async () => {
      const diceRoll = await recordDice(me.roomId, sessionId, roll, {
        hidden,
        senderId: me.memberId,
      });
      await persistAndDeliver(
        me.roomId,
        sessionId,
        { type: 'dice', roll: diceRoll, hidden, senderId: me.memberId },
        routing,
      );
    });
  }

  /**
   * 状态板写路径（T-M5-06，TDD §5.5，TC-FR-09-001~003）：仅 Host 可写（引擎写路径走
   * engine-writes，不经 socket）；整个「校验 → 乐观锁 → 落盘 → 广播」在房间串行队列内，
   * 与消息主链路同一把队（读改写并发安全）。expectedVersion 过期 → E-ST-01 拒绝 +
   * 广播当前最新版，让发起者与全员对齐后再重试。
   */
  async function handleStateUpdate(socket: Socket, data: StateUpdatePayload): Promise<void> {
    const me = presence.get(socket.id);
    if (!me) {
      emitError(socket, 'E-ROOM-01', '尚未加入房间');
      return;
    }
    const room = await readRoomFile(layout, me.roomId);
    // T-M8-06：副 Host（房间标记 coHostMemberId）与 Host 同权（快照/状态编辑；掉线代行）
    if (me.role !== 'host' && me.memberId !== room?.coHostMemberId) {
      emitError(socket, 'E-ROOM-01', '仅 Host/副 Host 可编辑状态板');
      return;
    }
    const sessionId = room?.activeSessionId;
    if (!room || !sessionId) {
      emitError(socket, 'E-ROOM-01', '尚未开团，暂无状态板可编辑');
      return;
    }

    await enqueue(me.roomId, async () => {
      const board = await boardFor(me.roomId, sessionId);
      const result = applyStatePatch(board, data.patch, data.expectedVersion);
      if (!result.ok) {
        emitError(socket, 'E-ST-01', '状态板已被他人更新，请以最新版为准重试');
        emitChecked(io.to(`room:${me.roomId}`), 'state:broadcast', {
          stateBoard: result.current,
        });
        return;
      }
      stateBoards.set(sessionId, result.next);
      await saveStateBoard(layout, me.roomId, sessionId, result.next);
      emitChecked(io.to(`room:${me.roomId}`), 'state:broadcast', { stateBoard: result.next });
    });
  }

  /**
   * 快照生成（T-M5-07，TDD §5.5 / SDD §5.4）：仅 Host 触发，把当前状态板作为
   * SnapshotMsg 入流（WAP 落盘 + 全房广播）。数值权威仍是 state.json（S2 每轮注入
   * 当前板），快照是流内的存档点：断线补发与回放可从快照消息看到版本锚点。
   */
  async function handleStateSnapshot(socket: Socket): Promise<void> {
    const me = presence.get(socket.id);
    if (!me) {
      emitError(socket, 'E-ROOM-01', '尚未加入房间');
      return;
    }
    const room = await readRoomFile(layout, me.roomId);
    if (me.role !== 'host' && me.memberId !== room?.coHostMemberId) {
      emitError(socket, 'E-ROOM-01', '仅 Host/副 Host 可生成快照');
      return;
    }
    const sessionId = room?.activeSessionId;
    if (!room || !sessionId) {
      emitError(socket, 'E-ROOM-01', '尚未开团，暂无状态板可快照');
      return;
    }

    await enqueue(me.roomId, async () => {
      const board = await boardFor(me.roomId, sessionId);
      await persistAndDeliver(me.roomId, sessionId, { type: 'state_snapshot', stateBoard: board });
    });
  }

  /**
   * AI 梗概确认（v3 T-M11-04，FR-36 / D-01）：Host only——确认（可手改）后写回
   * session.synopsis。D-01 的 Host 权威保留：唯一写入口是这里，AI 只产提案。
   */
  async function handleSynopsisConfirm(
    socket: Socket,
    data: SynopsisConfirmPayload,
    ack: Ack,
  ): Promise<void> {
    const me = presence.get(socket.id);
    if (!me) {
      ack?.({ ok: false, code: 'E-ROOM-01', message: '尚未加入房间' });
      return;
    }
    if (me.role !== 'host') {
      ack?.({ ok: false, code: 'E-ROOM-01', message: '仅 Host 可确认梗概' });
      return;
    }
    const session = await readSession(layout, me.roomId, data.sessionId);
    if (!session || session.roomId !== me.roomId) {
      ack?.({ ok: false, code: 'E-ROOM-01', message: '会话不存在' });
      return;
    }
    const updated = await updateSynopsis(layout, me.roomId, data.sessionId, data.text);
    if (!updated) {
      ack?.({ ok: false, code: 'E-ROOM-01', message: '会话不存在' });
      return;
    }
    dismissProposal(data.sessionId);
    ack?.({ ok: true, synopsis: updated.synopsis });
  }

  /** 丢弃梗概提案（Host only）：提案不入盘，直接清内存态 */
  async function handleSynopsisDismiss(
    socket: Socket,
    data: SynopsisDismissPayload,
    ack: Ack,
  ): Promise<void> {
    const me = presence.get(socket.id);
    if (!me) {
      ack?.({ ok: false, code: 'E-ROOM-01', message: '尚未加入房间' });
      return;
    }
    if (me.role !== 'host') {
      ack?.({ ok: false, code: 'E-ROOM-01', message: '仅 Host 可处理梗概提案' });
      return;
    }
    dismissProposal(data.sessionId);
    ack?.({ ok: true });
  }

  /**
   * 指令失败块留档（T-M3-07，测试文档 §12.4）：解析失败 / 白名单拒绝的原始文本
   * 追加到 `data/logs/ai-directive.jsonl`，供回归分析「KP 到底吐错了什么」。
   * 留档失败不影响回合（可观测旁路，绝不能反过来打断跑团）。
   */
  function recordDirectiveFailure(roomId: string, sessionId: string, ev: DirectiveScanEvent): void {
    if (ev.kind !== 'parse-error' && ev.kind !== 'rejected') return;
    const line = `${JSON.stringify({
      ts: new Date().toISOString(),
      roomId,
      sessionId,
      kind: ev.kind,
      block: ev.block,
      reason: ev.reason,
      raw: ev.raw,
    })}\n`;
    void mkdir(layout.logsDir, { recursive: true })
      .then(() => appendFile(layout.directiveLogFile, line, 'utf8'))
      .catch((err: unknown) => {
        console.error('[gateway] 指令留档失败：', err);
      });
  }

  /**
   * LLM 埋点包装（T-M6-03，R-02 / TDD §9）：在原适配器外套一层，按会话记录
   * 调用耗时、usage 的输入输出 token 与失败次数。失败同样记耗时——用户体感到的
   * 等待真实发生了；失败不记 token（provider 没回 usage）。
   *
   * 为什么不改 loop.ts：埋点是网关关切，领域层保持纯编排；包一层即可覆盖
   * 一个回合内的全部续写请求，不改 runAiTurn 的端口契约。
   */
  function instrumentLlm(inner: LlmAdapter, sessionId: string): LlmAdapter {
    return {
      id: inner.id,
      async chat(req, onDelta) {
        const startedAt = Date.now();
        try {
          const response = await inner.chat(req, onDelta);
          metrics.recordLlmCall(sessionId, Date.now() - startedAt, response.usage);
          return response;
        } catch (err) {
          metrics.recordLlmFailure(sessionId, Date.now() - startedAt);
          throw err;
        }
      },
    };
  }

  /**
   * 排程一个 AI 回合（T-M3-06，D-07）：进入房间级 AI 串行队列；回合完成后开启新「轮」。
   * 触发源：玩家 IC 消息（triggerSeq=该消息 seq）或 ai:invoke（triggerSeq=当前 lastSeq）。
   * alwaysFinish：ai:invoke 是 KP 主动要回应，空回包也要给 narration:done 信号
   * （2026-10-08 模拟实团回归：守卫过宽会让等 done 的调用方永久挂住）。
   */
  function scheduleAiTurn(
    roomId: string,
    sessionId: string,
    triggerSeq: number,
    options: { alwaysFinish?: boolean } = {},
  ): void {
    if (!deps.llm || !deps.chat) return;
    const llm = deps.llm;
    const baseChat = deps.chat;
    void enqueueAi(roomId, async () => {
      const tracker = trackers.get(sessionId) ?? new DirectiveSuccessTracker();
      trackers.set(sessionId, tracker);
      // KP 侧告警目标（T-M8-06）：副 Host 在线 sockets——掉线代行场景副 Host 也须知情。
      // 作用域在 try 外：catch 侧同样要用；读盘失败时按无副 Host 兜底。
      let coHostIds: string | null | undefined;
      try {
        coHostIds = (await readRoomFile(layout, roomId))?.coHostMemberId;
      } catch {
        coHostIds = undefined;
      }
      const alertTargets = (): string[] => [
        ...(roomHostSockets.get(roomId) ?? []),
        ...(coHostIds ? (memberSockets.get(coHostIds) ?? []) : []),
      ];
      try {
        // 预热状态板懒加载（T-M5-04）：AI 回合可能先于任何 state:update 发生，
        // 不预热则名册查无 PC，检定全落 E-AI-01。读盘走 JsonStore 文件锁，无竞态损坏。
        await boardFor(roomId, sessionId);
        // 会话级设置优先（T-M6-04）：temperature 取当前会话设置——KP 控制台改完
        // 下一次调用即生效；会话读不到时回退装配常量（缺省 0.7）。
        const session = await readSession(layout, roomId, sessionId);
        const chat = session
          ? { ...baseChat, temperature: session.settings.temperature }
          : baseChat;
        // 规则书随会话（T-M7-04）：AI 检定骰、玩家骰与引擎写路径的损失表共用同一套判定
        const sessionRulebook = sessionRuleBook(session);
        // 梗概提案（T-M11-04）：捕获本轮管线 trace，回合结束后链外判断是否生成
        let turnTrace: import('../pipeline/types.js').PipelineTrace | undefined;
        await runAiTurn(
          triggerSeq,
          {
            llm: instrumentLlm(llm, sessionId),
            chat,
            // 真实名册（T-M5-04）：按本会话状态板取技能值（含 roster 声明装配的初始板）
            roster: createStateBoardRoster(stateBoards.get(sessionId)),
            // 数值效果（T-M8-03/04）：取值源与写板目标
            getBoard: () => stateBoards.get(sessionId),
            // 引擎写板在房间队列内对**当前板**现算（同一轮多条效果依次累加，不吃过期快照）；
            // 乐观锁冲突（Host 编辑抢先）→ 广播最新版对齐 + KP 告警，效果丢弃
            applyHpEffect: async (key, kind, roll) => {
              let applied: { before: number; after: number } | null = null;
              await enqueue(roomId, async () => {
                const board = await boardFor(roomId, sessionId);
                const produced = hpPatch(board, key, kind, roll);
                if (!produced.ok) return;
                const pc = board.pcs[key];
                if (!pc || pc.sheet.rulebook !== 'dnd5e') return;
                const lock = applyStatePatch(board, produced.patch, board.version);
                if (!lock.ok) {
                  for (const socketId of alertTargets()) {
                    emitError(io.to(socketId), 'E-ST-01', '引擎写状态板时版本冲突，本次效果未落盘');
                  }
                  emitChecked(io.to(`room:${roomId}`), 'state:broadcast', {
                    stateBoard: lock.current,
                  });
                  return;
                }
                const before = pc.sheet.hp.current;
                const after = lock.next.pcs[key]?.sheet;
                if (!after || after.rulebook !== 'dnd5e') return;
                stateBoards.set(sessionId, lock.next);
                await saveStateBoard(layout, roomId, sessionId, lock.next);
                emitChecked(io.to(`room:${roomId}`), 'state:broadcast', { stateBoard: lock.next });
                applied = { before, after: after.hp.current };
              });
              return applied;
            },
            applySanityEffect: async (key, sanRoll, lossHint, random) => {
              let applied: {
                lossRoll: ParsedRoll;
                loss: number;
                before: number;
                after: number;
                desc: string;
              } | null = null;
              await enqueue(roomId, async () => {
                const board = await boardFor(roomId, sessionId);
                const pc = board.pcs[key];
                if (!pc || pc.sheet.rulebook !== 'coc7' || !sessionRulebook.sanityRule) return;
                // 损失表档位以**当前 SAN** 为判定目标（同一轮多次理智检定逐条基于最新值）
                const tier = sessionRulebook.sanityRule(sanRoll, pc.sheet.san);
                const lossExpr = lossHint ?? tier.loss;
                const lossRoll = rollDice(lossExpr, {
                  random: random ?? createCsprngRandom(),
                  rulebook: sessionRulebook,
                });
                const produced = sanityLossPatch(board, key, sanRoll, lossRoll, sessionRulebook);
                if (!produced.ok) return;
                // 损失骰 DiceMsg：审计先行（已在队列内，直接 recordDice，不再嵌套入队）
                const diceRoll = await recordDice(roomId, sessionId, lossRoll, { hidden: false });
                const lock = applyStatePatch(board, produced.patch, board.version);
                if (!lock.ok) {
                  for (const socketId of alertTargets()) {
                    emitError(io.to(socketId), 'E-ST-01', '引擎写状态板时版本冲突，本次效果未落盘');
                  }
                  emitChecked(io.to(`room:${roomId}`), 'state:broadcast', {
                    stateBoard: lock.current,
                  });
                  return;
                }
                const before = pc.sheet.san;
                stateBoards.set(sessionId, lock.next);
                await saveStateBoard(layout, roomId, sessionId, lock.next);
                await persistAndDeliver(roomId, sessionId, {
                  type: 'dice',
                  roll: diceRoll,
                  hidden: false,
                });
                emitChecked(io.to(`room:${roomId}`), 'state:broadcast', { stateBoard: lock.next });
                const after = lock.next.pcs[key]?.sheet;
                if (!after || after.rulebook !== 'coc7') return;
                applied = {
                  lossRoll,
                  loss: produced.loss,
                  before,
                  after: after.san,
                  desc: lossHint ? `KP 指定损失 ${lossExpr}` : tier.desc,
                };
              });
              return applied;
            },
            // 资源计数器（T-M12-02，FR-38）：不掷骰，队列内 clamp 后乐观锁落盘广播
            applyResourceEffect: async (key, name, delta) => {
              let applied: { before: number; after: number } | null = null;
              await enqueue(roomId, async () => {
                const board = await boardFor(roomId, sessionId);
                const produced = resourcePatch(board, key, name, delta);
                if (!produced.ok) return;
                const lock = applyStatePatch(board, produced.patch, board.version);
                if (!lock.ok) {
                  for (const socketId of alertTargets()) {
                    emitError(
                      io.to(socketId),
                      'E-ST-01',
                      '引擎写状态板时版本冲突，本次资源变动未落盘',
                    );
                  }
                  emitChecked(io.to(`room:${roomId}`), 'state:broadcast', {
                    stateBoard: lock.current,
                  });
                  return;
                }
                stateBoards.set(sessionId, lock.next);
                await saveStateBoard(layout, roomId, sessionId, lock.next);
                emitChecked(io.to(`room:${roomId}`), 'state:broadcast', { stateBoard: lock.next });
                applied = { before: produced.before, after: produced.after };
              });
              return applied;
            },
            // 规则书随会话（T-M7-04）：AI 检定骰与玩家骰走同一套判定
            rulebook: sessionRulebook,
            tracker,
            buildMessages: async () => {
              const trace = await buildPreviewTrace(layout, roomId, sessionId, {}, deps.recall);
              turnTrace = trace;
              return trace.messages;
            },
            emitDice: async (roll) => {
              await enqueue(roomId, async () => {
                const diceRoll = await recordDice(roomId, sessionId, roll, { hidden: false });
                await persistAndDeliver(roomId, sessionId, {
                  type: 'dice',
                  roll: diceRoll,
                  hidden: false,
                });
              });
            },
            emitDirectiveResult: async (content) => {
              await enqueue(roomId, () =>
                persistAndDeliver(roomId, sessionId, {
                  type: 'system',
                  subtype: 'ai_directive_result',
                  content,
                }),
              );
            },
            emitNarrationDelta: (seq, delta) => {
              emitChecked(io.to(`room:${roomId}`), 'narration:delta', { seq, delta });
            },
            finishNarration: async (_triggerSeq, content) => {
              const seq = await enqueue(roomId, () =>
                persistAndDeliver(roomId, sessionId, { type: 'narration', content }),
              );
              emitChecked(io.to(`room:${roomId}`), 'narration:done', { seq });
            },
            alertKp: (code, message) => {
              // E-AI-01 玩家无感：告警只定向 Host/副 Host（TDD §11；T-M8-06 副 Host 代行）
              for (const socketId of alertTargets()) {
                emitError(io.to(socketId), code, message);
              }
            },
            recordDirective: (ev) => {
              recordDirectiveFailure(roomId, sessionId, ev);
            },
            notifyFallback: async () => {
              await enqueue(roomId, () =>
                persistAndDeliver(roomId, sessionId, {
                  type: 'system',
                  subtype: 'notice',
                  content: 'KP 指令协议本轮停用，请玩家使用 .r 手动掷骰',
                }),
              );
            },
          },
          options,
        );
        // AI 梗概提案（T-M11-04，ADR-3-09 链外）：回合完成后判断，不占主叙事循环。
        // 开关 settings.aiSynopsis（默认关）；trim>0 才生成；失败静默回退无提案。
        if (session?.settings.aiSynopsis === true && turnTrace) {
          const s5 = turnTrace.stages.find((s) => s.name === 'S5-history-trim');
          const detail = s5?.detail as { total?: number; kept?: number } | undefined;
          if (detail && (detail.total ?? 0) > (detail.kept ?? 0)) {
            void proposeSynopsis({
              layout,
              roomId,
              sessionId,
              totalMessages: detail.total ?? 0,
              keptMessages: detail.kept ?? 0,
              keepCount: session.settings.maxHistoryMessages,
              llm,
              chat,
              recordLlmCall: (latencyMs, usage) =>
                metrics.recordLlmCall(sessionId, latencyMs, usage),
              recordLlmFailure: (latencyMs) => metrics.recordLlmFailure(sessionId, latencyMs),
            })
              .then((proposal) => {
                if (!proposal) return;
                for (const socketId of alertTargets()) {
                  emitChecked(io.to(socketId), 'synopsis:proposed', {
                    sessionId,
                    proposal: proposal.proposal,
                    createdAt: proposal.createdAt,
                  });
                }
              })
              .catch(() => undefined); // 链外尽力而为
          }
        }
      } catch (err) {
        // buildMessages/持久化侧未预期失败：对 Host 告警，回合终止（消息主链路不受影响）
        console.error('[gateway] AI 回合失败：', err);
        for (const socketId of alertTargets()) {
          emitError(io.to(socketId), 'E-SRV-01', 'AI 回合内部错误');
        }
      } finally {
        aiRounds.set(roomId, (aiRounds.get(roomId) ?? 0) + 1);
      }
    });
  }

  /** ai:invoke 显式触发（TDD §4.1）：player+，每人每轮 1 次（D-07 轮定义） */
  async function handleAiInvoke(socket: Socket): Promise<void> {
    const me = presence.get(socket.id);
    if (!me) {
      emitError(socket, 'E-ROOM-01', '尚未加入房间');
      return;
    }
    if (me.role === 'observer') {
      emitError(socket, 'E-ROOM-01', '观察者不能请求 KP 响应');
      return;
    }
    if (!deps.llm || !deps.chat) {
      emitError(socket, 'E-ROOM-01', 'AI 功能未启用');
      return;
    }
    const room = await readRoomFile(layout, me.roomId);
    const sessionId = room?.activeSessionId;
    if (!room || !sessionId) {
      emitError(socket, 'E-ROOM-01', '尚未开团，KP 无法响应');
      return;
    }
    const round = aiRounds.get(me.roomId) ?? 0;
    const invoked = memberInvokeRound.get(me.roomId) ?? new Map<string, number>();
    if (invoked.get(me.memberId) === round) {
      emitError(socket, 'E-ROOM-01', '每人每轮只能请求一次 KP 响应');
      return;
    }
    invoked.set(me.memberId, round);
    memberInvokeRound.set(me.roomId, invoked);

    const lastSeq = seqCounters.get(sessionId) ?? 0;
    scheduleAiTurn(me.roomId, sessionId, lastSeq, { alwaysFinish: true });
  }

  /** KP prompt 预览（T-M2-05，FR-13）：host only，trace 定向回请求 socket；seq 语义见 PreviewOptions */
  async function handlePreviewPrompt(socket: Socket, data: KpPreviewPromptPayload): Promise<void> {
    const me = presence.get(socket.id);
    if (!me) {
      emitError(socket, 'E-ROOM-01', '尚未加入房间');
      return;
    }
    if (me.role !== 'host') {
      emitError(socket, 'E-ROOM-01', '仅 Host 可预览 prompt');
      return;
    }
    const room = await readRoomFile(layout, me.roomId);
    if (!room?.activeSessionId) {
      emitError(socket, 'E-ROOM-01', '尚未开团，暂无 prompt 可预览');
      return;
    }
    const trace = await buildPreviewTrace(
      layout,
      me.roomId,
      room.activeSessionId,
      { seq: data.seq },
      deps.recall,
    );
    emitChecked(socket, 'kp:promptPreview', { pipeline: trace });
  }

  /**
   * 房内实时指标（T-M6-03/05，FR-13 / R-01 / R-02）：host only，会话级口径，
   * 定向回请求 socket（不广播——其他成员不该看到本团的 token/成本与暗骰计数）。
   *
   * 为什么房内要再开一条：`GET /metrics` 走管理面令牌，前端不带 X-Admin-Token，
   * 且它给的是全局数、不带会话维度。控制台要的是「本会话现在烧了多少钱」。
   * 指令成功率直接取本会话 tracker（R-01 唯一口径，不另起一套统计）。
   */
  async function handleMetrics(socket: Socket, data: KpMetricsPayload): Promise<void> {
    const me = presence.get(socket.id);
    if (!me) {
      emitError(socket, 'E-ROOM-01', '尚未加入房间');
      return;
    }
    if (me.role !== 'host') {
      emitError(socket, 'E-ROOM-01', '仅 Host 可查看实时指标');
      return;
    }
    const room = await readRoomFile(layout, me.roomId);
    const sessionId = data.sessionId ?? room?.activeSessionId;
    if (!sessionId) {
      emitError(socket, 'E-ROOM-01', '尚未开团，暂无指标可看');
      return;
    }
    // 显式指定会话时必须属于本房：房内事件不得跨房读指标（只比默认路径多一次读盘）
    if (
      data.sessionId !== undefined &&
      (await readSession(layout, me.roomId, sessionId)) === null
    ) {
      emitError(socket, 'E-ROOM-01', '会话不存在');
      return;
    }
    const tracker = trackers.get(sessionId);
    const directives = tracker
      ? { attempts: tracker.totals.attempts, successes: tracker.totals.successes }
      : { attempts: 0, successes: 0 };
    emitChecked(socket, 'kp:metricsResult', metrics.sessionSnapshot(sessionId, directives));
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
    // ai:invoke 配额记录随成员离开清理，防 Map<memberId, round> 长期驻留内存
    const invoked = memberInvokeRound.get(me.roomId);
    if (invoked) {
      invoked.delete(me.memberId);
      if (invoked.size === 0) memberInvokeRound.delete(me.roomId);
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
    // room:sync：离线者必须从其余成员的成员栏消失（成员名映射失效会退回 memberId 直显）
    await emitRoomSync(me.roomId);
  }

  /**
   * Host 转让（T-M8-06，FR-26，设计 §5.5）：当前 Host 出示 hostToken，把 Host 身份
   * 让给同房间另一名**在线**成员。效果链：members.json 角色换位 → 在线 presence 升降级 →
   * hostToken 轮换（旧 token 立即失效，防离任 Host 凭旧凭据回收）→ room.hostAuth='member'
   * （新 Host 重连凭成员角色标记 + memberId 恢复，无需再持 token）→ 全房 notice 广播。
   * 目标若原为副 Host，副 Host 标记顺带清空（一身不二职）。
   */
  async function transferHost(
    roomId: string,
    hostToken: string,
    toMemberId: string,
  ): Promise<{ ok: true; memberId: string } | { ok: false; code: ErrorCode; message: string }> {
    return enqueue(roomId, async () => {
      const room = await readRoomFile(layout, roomId);
      if (!room) return { ok: false, code: 'E-ROOM-01' as const, message: '房间不存在' };
      if (hostToken !== room.hostToken) {
        return { ok: false, code: 'E-ROOM-01' as const, message: 'hostToken 不匹配' };
      }
      const members = await readMembers(layout, roomId);
      const target = members.find((m) => m.id === toMemberId);
      if (!target) return { ok: false, code: 'E-ROOM-01' as const, message: '目标成员不存在' };
      if (target.role === 'host') {
        return { ok: false, code: 'E-ROOM-01' as const, message: '目标已是 Host' };
      }
      if (target.role === 'observer') {
        return { ok: false, code: 'E-ROOM-01' as const, message: '观察者不能接任 Host' };
      }
      if (!roomMembers.get(roomId)?.has(toMemberId)) {
        return { ok: false, code: 'E-ROOM-01' as const, message: '目标成员不在线' };
      }

      // 角色换位（先记住离任 Host，members.json 更新后用于 presence 降级）
      const formerHostIds = members.filter((m) => m.role === 'host').map((m) => m.id);
      for (const id of formerHostIds) await updateMemberRole(layout, roomId, id, 'player');
      await updateMemberRole(layout, roomId, toMemberId, 'host');
      for (const id of formerHostIds) setPresenceRole(roomId, id, 'player');
      setPresenceRole(roomId, toMemberId, 'host');

      await saveRoomFile(layout, {
        ...room,
        hostToken: generateHostToken(),
        hostAuth: 'member',
        ...(room.coHostMemberId === toMemberId ? { coHostMemberId: null } : {}),
      });
      const sessionId = room.activeSessionId;
      if (sessionId) {
        await persistAndDeliver(roomId, sessionId, {
          type: 'system',
          subtype: 'notice',
          content: `Host 已转让给 ${target.name}`,
        });
      }
      // room:sync：角色换位必须到达全员成员栏（原 Host 降为玩家、新 Host 标记）
      await emitRoomSync(roomId);
      return { ok: true, memberId: toMemberId };
    });
  }

  /**
   * 副 Host 设置/撤销（T-M8-06，FR-26）：房间级角色标记（coHostMemberId），不发新 token。
   * 权限面 = 快照 + 状态编辑（canModerateState）；Host 在线与否不影响（掉线代行即此）。
   */
  async function setCoHost(
    roomId: string,
    hostToken: string,
    memberId: string | null,
  ): Promise<{ ok: true } | { ok: false; code: ErrorCode; message: string }> {
    return enqueue(roomId, async () => {
      const room = await readRoomFile(layout, roomId);
      if (!room) return { ok: false, code: 'E-ROOM-01' as const, message: '房间不存在' };
      if (hostToken !== room.hostToken) {
        return { ok: false, code: 'E-ROOM-01' as const, message: 'hostToken 不匹配' };
      }
      if (memberId !== null) {
        const target = (await readMembers(layout, roomId)).find((m) => m.id === memberId);
        if (!target) return { ok: false, code: 'E-ROOM-01' as const, message: '目标成员不存在' };
        if (target.role === 'host') {
          return { ok: false, code: 'E-ROOM-01' as const, message: 'Host 无需副 Host 标记' };
        }
        if (target.role === 'observer') {
          return { ok: false, code: 'E-ROOM-01' as const, message: '观察者不能任副 Host' };
        }
        if (!roomMembers.get(roomId)?.has(memberId)) {
          return { ok: false, code: 'E-ROOM-01' as const, message: '目标成员不在线' };
        }
      }
      const previous = room.coHostMemberId ?? null;
      await saveRoomFile(layout, { ...room, coHostMemberId: memberId });
      const sessionId = room.activeSessionId;
      if (sessionId && previous !== memberId) {
        const nameOf = async (id: string): Promise<string> =>
          (await readMembers(layout, roomId)).find((m) => m.id === id)?.name ?? id;
        const content =
          memberId === null
            ? previous === null
              ? '副 Host 状态未变化'
              : `副 Host（${await nameOf(previous)}）已撤销`
            : `${await nameOf(memberId)} 已任副 Host`;
        if (content !== '副 Host 状态未变化') {
          await persistAndDeliver(roomId, sessionId, {
            type: 'system',
            subtype: 'notice',
            content,
          });
        }
      }
      return { ok: true };
    });
  }

  /** 在线成员的 presence 角色升降级（T-M8-06 转让）：该成员的全部连接 + Host socket 表同步 */
  function setPresenceRole(roomId: string, memberId: string, role: MemberRole): void {
    const sockets = memberSockets.get(memberId);
    if (!sockets) return;
    for (const socketId of sockets) {
      const p = presence.get(socketId);
      if (p && p.roomId === roomId) p.role = role;
    }
    const hosts = roomHostSockets.get(roomId) ?? new Set<string>();
    if (role === 'host') {
      for (const socketId of sockets) hosts.add(socketId);
    } else {
      for (const socketId of sockets) hosts.delete(socketId);
    }
    if (hosts.size > 0) roomHostSockets.set(roomId, hosts);
    else roomHostSockets.delete(roomId);
  }

  return {
    async close(): Promise<void> {
      io.disconnectSockets(true);
      io.removeAllListeners();
    },
    transferHost,
    setCoHost,
    directiveStats(): { attempts: number; successes: number; rate: number } {
      let attempts = 0;
      let successes = 0;
      for (const tracker of trackers.values()) {
        const totals = tracker.totals;
        attempts += totals.attempts;
        successes += totals.successes;
      }
      return { attempts, successes, rate: attempts === 0 ? 1 : successes / attempts };
    },
  };
}
