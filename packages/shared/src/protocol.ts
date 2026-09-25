import { z } from 'zod';
import { AppErrorSchema } from './errors.js';
import { MessageSchema } from './message.js';
import {
  SessionSettingsSchema,
  StateBoardPcSchema,
  StateBoardSceneSchema,
  StateBoardSchema,
} from './domain.js';

/**
 * Socket.IO 事件契约（T-M1-04，TDD §4.1/§4.2 + docs/socketio-asyncapi.yaml）。
 *
 * 双向校验不变式（TDD §8）：入站事件 payload 必须命中 CLIENT_EVENT_SCHEMAS，
 * 出站事件同样按 Schema 校验；非白名单事件直接断连（isClientEvent/isServerEvent）。
 * 非法 payload 一律断连，不回业务错误（防伪造事件注入）。
 */

// ---- 客户端 → 服务端（TDD §4.1）----

export const RoomJoinSchema = z.object({
  /** 6 位邀请码 */
  inviteCode: z.string().length(6),
  /** 房内展示昵称 */
  name: z.string().min(1).max(50),
  /** 决议 D-02：Host 不可申请（建房者即 Host，v1 不可转让）；缺省为 player */
  wantRole: z.enum(['player', 'observer']).default('player'),
  /**
   * 开放问题①（按建议默认执行，待复核）：建房者以 REST 建房返回的 hostToken
   * 证明 Host 身份；缺省或错误时按 wantRole 加入。
   */
  hostToken: z.string().optional(),
  /** 断线重连：携带原 memberId 复用身份（缺省则新建成员） */
  memberId: z.string().optional(),
  /** 断线重连（T-M1-08）：客户端已收到的最大 seq，服务端据此补发缺口 */
  lastSeq: z.number().int().nonnegative().optional(),
});
export type RoomJoinPayload = z.infer<typeof RoomJoinSchema>;

export const SessionStartSchema = z.object({
  moduleId: z.string().min(1),
  settings: SessionSettingsSchema,
});
export type SessionStartPayload = z.infer<typeof SessionStartSchema>;

export const MsgSendSchema = z.object({
  type: z.enum(['ic', 'ooc']),
  content: z.string(),
  /**
   * OOC 可见性（TDD §3.2）：all=全房可见、host=仅 Host 可见。
   * 带 targetId 时一律按 whisper 处理，本字段忽略。
   */
  visibility: z.enum(['all', 'host']).optional(),
  /** visibility=whisper 时的收件人 memberId */
  targetId: z.string().optional(),
});
export type MsgSendPayload = z.infer<typeof MsgSendSchema>;

export const AiInvokeSchema = z.object({
  reason: z.string().optional(),
});
export type AiInvokePayload = z.infer<typeof AiInvokeSchema>;

export const DiceRollSchema = z.object({
  expr: z.string(),
  /** 暗骰（FR-14；决议 D-10：仅 Host 可用） */
  hidden: z.boolean().optional(),
  label: z.string().optional(),
});
export type DiceRollPayload = z.infer<typeof DiceRollSchema>;

/** 状态板局部更新（TDD §5.5）：仅允许的业务字段，version 走乐观锁单独传递 */
export const StatePatchSchema = z.object({
  pcs: z.record(z.string(), StateBoardPcSchema).optional(),
  scene: StateBoardSceneSchema.optional(),
  facts: z.array(z.string()).optional(),
});
export type StatePatch = z.infer<typeof StatePatchSchema>;

export const StateUpdateSchema = z.object({
  patch: StatePatchSchema,
  /** 乐观锁：过期即 E-ST-01 拒绝并广播最新版 */
  expectedVersion: z.number().int().nonnegative(),
});
export type StateUpdatePayload = z.infer<typeof StateUpdateSchema>;

export const StateSnapshotSchema = z.object({});
export type StateSnapshotPayload = z.infer<typeof StateSnapshotSchema>;

export const KpPreviewPromptSchema = z.object({
  /** 指定历史 seq 的预览（TC-FR-13-002）；缺省取当前状态 */
  seq: z.number().int().nonnegative().optional(),
});
export type KpPreviewPromptPayload = z.infer<typeof KpPreviewPromptSchema>;

// ---- 服务端 → 客户端（TDD §4.2，出站同样须过 Schema）----

export const MsgBroadcastSchema = z.object({
  msg: MessageSchema,
});
export type MsgBroadcastPayload = z.infer<typeof MsgBroadcastSchema>;

export const NarrationDeltaSchema = z.object({
  seq: z.number().int().nonnegative(),
  delta: z.string(),
});
export type NarrationDeltaPayload = z.infer<typeof NarrationDeltaSchema>;

export const NarrationDoneSchema = z.object({
  seq: z.number().int().nonnegative(),
});
export type NarrationDonePayload = z.infer<typeof NarrationDoneSchema>;

export const StateBroadcastSchema = z.object({
  stateBoard: StateBoardSchema,
});
export type StateBroadcastPayload = z.infer<typeof StateBroadcastSchema>;

/** PipelineTrace 的线上形状（TDD §5.1；与 server/src/pipeline/types.ts 结构对应） */
export const PipelineTraceSchema = z.object({
  stages: z.array(
    z.object({
      name: z.string(),
      tokenCount: z.number(),
      detail: z.unknown(),
    }),
  ),
  messages: z.array(
    z.object({
      role: z.enum(['system', 'user', 'assistant']),
      content: z.string(),
    }),
  ),
});
export type PipelineTracePayload = z.infer<typeof PipelineTraceSchema>;

export const KpPromptPreviewSchema = z.object({
  pipeline: PipelineTraceSchema,
});
export type KpPromptPreviewPayload = z.infer<typeof KpPromptPreviewSchema>;

/** 业务错误出口（TDD §4.2 error:app），code 必须落在 §11 错误码表内 */
export const ErrorAppSchema = AppErrorSchema;
export type ErrorAppPayload = z.infer<typeof ErrorAppSchema>;

// ---- 事件白名单（TDD §8：非白名单事件即断连）----

export const CLIENT_EVENTS = [
  'room:join',
  'session:start',
  'msg:send',
  'ai:invoke',
  'dice:roll',
  'state:update',
  'state:snapshot',
  'kp:previewPrompt',
] as const;
export type ClientEventName = (typeof CLIENT_EVENTS)[number];

export const SERVER_EVENTS = [
  'msg:broadcast',
  'narration:delta',
  'narration:done',
  'state:broadcast',
  'kp:promptPreview',
  'error:app',
] as const;
export type ServerEventName = (typeof SERVER_EVENTS)[number];

/** 入站事件 → Schema 映射（网关校验中间件的数据源） */
export const CLIENT_EVENT_SCHEMAS = {
  'room:join': RoomJoinSchema,
  'session:start': SessionStartSchema,
  'msg:send': MsgSendSchema,
  'ai:invoke': AiInvokeSchema,
  'dice:roll': DiceRollSchema,
  'state:update': StateUpdateSchema,
  'state:snapshot': StateSnapshotSchema,
  'kp:previewPrompt': KpPreviewPromptSchema,
} as const satisfies Record<ClientEventName, z.ZodType>;

/** 出站事件 → Schema 映射（出站广播前的自检） */
export const SERVER_EVENT_SCHEMAS = {
  'msg:broadcast': MsgBroadcastSchema,
  'narration:delta': NarrationDeltaSchema,
  'narration:done': NarrationDoneSchema,
  'state:broadcast': StateBroadcastSchema,
  'kp:promptPreview': KpPromptPreviewSchema,
  'error:app': ErrorAppSchema,
} as const satisfies Record<ServerEventName, z.ZodType>;

const CLIENT_EVENT_SET: ReadonlySet<string> = new Set<string>(CLIENT_EVENTS);
const SERVER_EVENT_SET: ReadonlySet<string> = new Set<string>(SERVER_EVENTS);

/** Set 判定天然免疫 `__proto__` 等原型链键（防伪造事件注入） */
export function isClientEvent(name: string): boolean {
  return CLIENT_EVENT_SET.has(name);
}

export function isServerEvent(name: string): boolean {
  return SERVER_EVENT_SET.has(name);
}
