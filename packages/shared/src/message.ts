import { z } from 'zod';
import { RollResultSchema } from './dice.js';
import { StateBoardSchema } from './domain.js';

/**
 * Message 类型系统（TDD §3.2，六类）。
 * 不变式：消息不可变（append-only），seq 在 Session 内严格单调递增。
 * MESSAGE_TYPES / MessageType 自本文件导出（原 index.ts 占位定义移入，保持单一来源）。
 */
export const MESSAGE_TYPES = [
  'ic',
  'ooc',
  'system',
  'dice',
  'narration',
  'state_snapshot',
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

/** 六类消息公共字段（TDD §3.2 BaseMsg） */
export const BaseMsgSchema = z.object({
  seq: z.number().int().nonnegative(),
  /** ISO8601 */
  ts: z.string(),
  sessionId: z.string(),
});

export const IcMsgSchema = BaseMsgSchema.extend({
  type: z.literal('ic'),
  senderId: z.string(),
  content: z.string(),
});
export type IcMsg = z.infer<typeof IcMsgSchema>;

export const OocVisibilitySchema = z.enum(['all', 'host', 'whisper']);
export type OocVisibility = z.infer<typeof OocVisibilitySchema>;

export const OocMsgSchema = BaseMsgSchema.extend({
  type: z.literal('ooc'),
  senderId: z.string(),
  content: z.string(),
  visibility: OocVisibilitySchema,
  /** visibility=whisper 时的私聊对象 */
  targetId: z.string().optional(),
});
export type OocMsg = z.infer<typeof OocMsgSchema>;

export const SystemMsgSubtypeSchema = z.enum(['ai_directive_result', 'join', 'leave', 'notice']);
export type SystemMsgSubtype = z.infer<typeof SystemMsgSubtypeSchema>;

export const SystemMsgSchema = BaseMsgSchema.extend({
  type: z.literal('system'),
  subtype: SystemMsgSubtypeSchema,
  content: z.string(),
});
export type SystemMsg = z.infer<typeof SystemMsgSchema>;

export const DiceMsgSchema = BaseMsgSchema.extend({
  type: z.literal('dice'),
  roll: RollResultSchema,
  /** true = 暗骰（FR-14）：结果仅广播 Host（权限语义见 D-10，待拍板） */
  hidden: z.boolean(),
});
export type DiceMsg = z.infer<typeof DiceMsgSchema>;

/** AI 叙事（流式）：streaming=false 后 content 即最终全文（TDD §4.2 narration:done 转正） */
export const NarrationMsgSchema = BaseMsgSchema.extend({
  type: z.literal('narration'),
  streaming: z.boolean(),
  content: z.string(),
});
export type NarrationMsg = z.infer<typeof NarrationMsgSchema>;

export const SnapshotMsgSchema = BaseMsgSchema.extend({
  type: z.literal('state_snapshot'),
  stateBoard: StateBoardSchema,
});
export type SnapshotMsg = z.infer<typeof SnapshotMsgSchema>;

/** 消息判别联合：非法 type 在 Schema 层直接拒绝 */
export const MessageSchema = z.discriminatedUnion('type', [
  IcMsgSchema,
  OocMsgSchema,
  SystemMsgSchema,
  DiceMsgSchema,
  NarrationMsgSchema,
  SnapshotMsgSchema,
]);
export type Message = z.infer<typeof MessageSchema>;
