import { MessageSchema, type MemberRole, type Message } from '@behindveil/shared';
import { JsonlStore } from '../../adapters/storage/jsonl-store.js';
import type { DataLayout } from '../../adapters/storage/layout.js';

/**
 * 消息持久化（T-M1-05/09，TDD §6 NFR-06）。
 *
 * WAP 不变式：appendMessage 返回即已 fsync，广播必须发生在其后（TC-FR-02-001）。
 * seq 由调用方（网关串行队列）分配——同一会话的分配与落盘必须串行，保证落盘顺序
 * 与 seq 顺序一致（施工文档 T-M1-05 注记）。
 */

export async function appendMessage(
  layout: DataLayout,
  roomId: string,
  sessionId: string,
  message: Message,
  store: JsonlStore = new JsonlStore(layout.messagesFile(roomId, sessionId)),
): Promise<void> {
  await store.append(message);
}

export interface MessagePage {
  /** 按 seq 降序（最新在前），供历史翻页 */
  messages: Message[];
  /** 该会话当前最大 seq（空会话为 0） */
  lastSeq: number;
}

export interface ReadMessagesOptions {
  /** 返回 seq < beforeSeq 的消息（向前翻页） */
  beforeSeq?: number;
  /** 单页条数 */
  limit?: number;
  /** 暗骰仅 Host 可见（D-10）：REST 历史默认剔除 hidden 骰，防未授权泄露 */
  excludeHidden?: boolean;
}

/**
 * 读一页历史（T-M1-09）。坏行跳过（与启动恢复同一容错口径），计数不计入返回。
 * store 可注入以复用句柄；缺省按需新开。
 */
export async function readMessagesPage(
  layout: DataLayout,
  roomId: string,
  sessionId: string,
  opts: ReadMessagesOptions = {},
  store: JsonlStore = new JsonlStore(layout.messagesFile(roomId, sessionId)),
): Promise<MessagePage> {
  const { records } = await store.readAll();
  const messages: Message[] = [];
  let lastSeq = 0;
  for (const record of records) {
    const parsed = MessageSchema.safeParse(record);
    if (!parsed.success) continue;
    const message = parsed.data;
    if (message.seq > lastSeq) lastSeq = message.seq;
    if (opts.excludeHidden && message.type === 'dice' && message.hidden) continue;
    if (opts.beforeSeq !== undefined && message.seq >= opts.beforeSeq) continue;
    messages.push(message);
  }
  messages.sort((a, b) => b.seq - a.seq);
  return { messages: messages.slice(0, opts.limit ?? 50), lastSeq };
}

/** 补发/回放的观察者身份：决定密语与暗骰能否投递给他（T-M4-02，FR-14 / D-10） */
export interface MessageViewer {
  memberId: string;
  role: MemberRole;
}

/**
 * 补发缺口（T-M1-08）：seq > afterSeq 的消息，按 seq 升序返回。
 *
 * `viewer` 为补发目标的身份，必填且不可省略为「不过滤」——
 * 断线补发的 lastSeq 由客户端给出，不按身份过滤等于把全房暗骰与密语拱手让人
 * （2026-09-25 代码审查最高优先级问题）。仅管理工具等无身份场景显式传 null。
 */
export async function readMessagesAfter(
  layout: DataLayout,
  roomId: string,
  sessionId: string,
  afterSeq: number,
  viewer: MessageViewer | null,
  store: JsonlStore = new JsonlStore(layout.messagesFile(roomId, sessionId)),
): Promise<Message[]> {
  const { records } = await store.readAll();
  const messages: Message[] = [];
  for (const record of records) {
    const parsed = MessageSchema.safeParse(record);
    if (!parsed.success) continue;
    const message = parsed.data;
    if (message.seq <= afterSeq) continue;
    if (!canSee(message, viewer)) continue;
    messages.push(message);
  }
  messages.sort((a, b) => a.seq - b.seq);
  return messages;
}

/** 可见性判定（与实时投递同源：Host 全见；暗骰归 Host+掷骰者；密语归收发双方+Host） */
export function canSee(message: Message, viewer: MessageViewer | null): boolean {
  if (!viewer) return true;
  if (viewer.role === 'host') return true;
  if (message.type === 'dice') {
    return !message.hidden || message.senderId === viewer.memberId;
  }
  if (message.type === 'ooc') {
    if (message.visibility === 'whisper') {
      return message.senderId === viewer.memberId || message.targetId === viewer.memberId;
    }
    if (message.visibility === 'host') return message.senderId === viewer.memberId;
  }
  return true;
}
