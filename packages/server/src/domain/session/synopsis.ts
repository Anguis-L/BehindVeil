import type { Message } from '@behindveil/shared';
import type { DataLayout } from '../../adapters/storage/layout.js';
import type { LlmAdapter, LlmMessage } from '../llm.js';
import { formatMessageLine } from '../../pipeline/stages.js';
import { readMessagesUpTo } from './messages.js';
/**
 * AI 剧情梗概（v3 T-M11-04，FR-36 / ADR-3-09，设计 §5.3）。
 *
 * S5 实际发生裁剪（trim>0）且 settings.aiSynopsis 开启时，**链外**调用 chat provider
 * 以被裁消息窗口生成 ≤400 字梗概**提案**——主链路延迟零影响，失败静默回退
 * 「无提案」（现状行为）。D-01 的 Host 权威保留：AI 只产提案，写盘永远经
 * Host 确认（synopsis:confirm），落盘走 sessions.updateSynopsis。
 *
 * 提案为进程内存态（每会话至多一条，新提案覆盖旧提案）；重启即失——
 * 梗概本体以 session.json 为权威，提案只是待确认的草稿。
 */

/** 提案正文硬上限（设计 §5.3：≤400 字；超长截断） */
export const SYNOPSIS_MAX_CHARS = 400;

export interface SynopsisProposal {
  sessionId: string;
  proposal: string;
  createdAt: string;
}

/** S5 裁剪口径的复算：与管线同一规则（取最近 keepCount 条） */
export function trimmedWindow(messages: Message[], keepCount: number): Message[] {
  return messages.length <= keepCount ? [] : messages.slice(0, messages.length - keepCount);
}

export function buildSynopsisPrompt(trimmed: Message[]): LlmMessage[] {
  const transcript = trimmed.map(formatMessageLine).join('\n');
  return [
    {
      role: 'system',
      content:
        '你是跑团记录员。把给定的剧情片段压缩成一段客观、按时间顺序的梗概，供后续叙事引用。只输出梗概正文，不要标题、不要评论、不要列点。',
    },
    {
      role: 'user',
      content: `以下是较早的剧情片段（共 ${trimmed.length} 条），请压缩成不超过 ${SYNOPSIS_MAX_CHARS} 字的梗概：\n\n${transcript}`,
    },
  ];
}

export function clampSynopsis(text: string): string {
  return text.length > SYNOPSIS_MAX_CHARS ? text.slice(0, SYNOPSIS_MAX_CHARS) : text;
}

const proposals = new Map<string, SynopsisProposal>();

/** 当前待确认提案（KP 控制台拉取/事件推送共用同一份） */
export function pendingProposal(sessionId: string): SynopsisProposal | undefined {
  return proposals.get(sessionId);
}

export function dismissProposal(sessionId: string): void {
  proposals.delete(sessionId);
}

/**
 * 裁剪发生后生成提案（链外调用）：生成失败/被裁窗口为空 → 静默无提案。
 * 返回 true 表示产生了新提案。
 */
export async function proposeSynopsis(opts: {
  layout: DataLayout;
  roomId: string;
  sessionId: string;
  totalMessages: number;
  keptMessages: number;
  keepCount: number;
  llm: LlmAdapter;
  chat: { model: string; temperature: number; maxTokens: number };
  /** 成本观测口（R-02）：调用了 chat 就要留痕 */
  recordLlmCall?: (
    latencyMs: number,
    usage?: { promptTokens: number; completionTokens: number },
  ) => void;
  recordLlmFailure?: (latencyMs: number) => void;
}): Promise<SynopsisProposal | null> {
  const trimmedCount = opts.totalMessages - opts.keptMessages;
  if (trimmedCount <= 0) return null;

  const all = await readMessagesUpTo(opts.layout, opts.roomId, opts.sessionId, undefined);
  // 与触发轮的裁剪口径对齐：被裁窗口 = 最早 trimmedCount 条（新消息落盘会造成轻微偏移，
  // 提案由 Host 确认，偏差可接受）
  const trimmed = all.slice(0, Math.min(trimmedCount, Math.max(0, all.length - opts.keepCount)));
  if (trimmed.length === 0) return null;

  const req = {
    messages: buildSynopsisPrompt(trimmed),
    model: opts.chat.model,
    temperature: opts.chat.temperature,
    maxTokens: opts.chat.maxTokens,
  };
  let content = '';
  const t0 = performance.now();
  try {
    const res = await opts.llm.chat(req, (delta) => {
      content += delta;
    });
    content = res.content || content;
    opts.recordLlmCall?.(performance.now() - t0, res.usage);
  } catch {
    opts.recordLlmFailure?.(performance.now() - t0);
    return null; // 失败回退「无提案」（ADR-3-09）
  }

  const proposal = clampSynopsis(content.trim());
  if (proposal.length === 0) return null;
  const entry: SynopsisProposal = {
    sessionId: opts.sessionId,
    proposal,
    createdAt: new Date().toISOString(),
  };
  proposals.set(opts.sessionId, entry);
  return entry;
}
