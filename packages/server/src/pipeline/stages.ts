import type { Message, WorldBookPosition } from '@behindveil/shared';
import { scanWorldBook, type ScanHit } from '../domain/worldbook/scan.js';
import type { LlmMessage } from '../domain/llm.js';
import type { Tokenizer } from './tokenizer.js';
import type { JsonValue, PipelineInput, StageName, StageTrace } from './types.js';

/**
 * S1–S7 阶段实现（T-M2-04 全量落地，TDD §5.1 阶段顺序）。
 *
 * 每阶段是独立纯函数、顺序执行并记录 trace；S7 硬顶回退通过重入 S5/S6 核心实现
 * （trace 每阶段一槽，S5/S6 记录首轮产物，回退过程见 S7.detail）。
 * 管线行为变更必须显式更新黄金用例（tests/golden/，TDD §5.1）。
 */

/** S1 元指令（TDD §5.1：「数值以状态板为准」；检定协议声明对应 §5.4） */
export const META_INSTRUCTION =
  '数值与状态一律以状态板为准；需要检定时输出 aidle 指令块向引擎请求，不得自行产生数值或宣告判定结果。';

/** 规则书速查（S1，随 KP 卡的 rulebook 扩展选择；v1 仅两套，TC-FR-03-003 依据） */
const RULEBOOK_QUICK_REFS: Record<'coc7' | 'dnd5e', string> = {
  coc7: '检定速查（COC7）：技能/属性检定掷 1d100，结果≤技能值为成功，≤1/2 为困难成功，≤1/5 为极难成功；≤1/5 技能值为大成功，≥96 或大于技能值为大失败。理智检定同法对照当前 SAN。',
  dnd5e: '检定速查（D&D 5e）：d20+调整值与 DC 比较；天然 20 为大成功，天然 1 为大失败。',
};

/** 阶段间传递的中间产物 */
export interface PipelineBundle {
  /** S1：system 骨架（KP 人格 + 规则速查 + 元指令） */
  skeleton: string;
  /** S2：状态板注入块 */
  stateBlock: string;
  /** S3：扫描命中集（S4 消费） */
  scanHits: ScanHit[];
  /** S4：预算内条目（S6 按 position 插入） */
  worldbookBlocks: Array<{
    uid: number;
    position: WorldBookPosition;
    depth: number | null;
    order: number;
    content: string;
  }>;
  /** S5：裁剪后历史 */
  history: Message[];
  /** S5：被裁历史的梗概（决议 D-01：v1 由 Host 手编 session.synopsis） */
  synopsis: string;
  /** S6：最终 LLM 消息 */
  messages: LlmMessage[];
}

export interface StageContext {
  input: PipelineInput;
  bundle: PipelineBundle;
  tokenizer: Tokenizer;
}

export type Stage = (ctx: StageContext) => StageTrace;

function trace(name: StageName, tokenCount: number, detail: JsonValue): StageTrace {
  return { name, tokenCount, detail };
}

/** S1 组装骨架：system = KP 人格 + 规则书速查 + 元指令（TDD §5.1） */
export const s1Skeleton: Stage = (ctx) => {
  const sections: string[] = [];
  const persona = ctx.input.kpCard.data.description;
  if (persona.trim().length > 0) sections.push(persona);
  const rulebook = ctx.input.kpCard.data.extensions.aidle?.rulebook;
  const quickRef = rulebook ? RULEBOOK_QUICK_REFS[rulebook] : undefined;
  if (quickRef) sections.push(quickRef);
  sections.push(META_INSTRUCTION);
  ctx.bundle.skeleton = sections.join('\n\n');
  return trace('S1-skeleton', ctx.tokenizer.count(ctx.bundle.skeleton), {
    sections: [
      ...(persona.trim().length > 0 ? ['kp-persona'] : []),
      ...(quickRef ? [`rulebook-quickref:${rulebook}`] : []),
      'meta-instruction',
    ],
  });
};

/** S2 状态注入：stateBoard → 结构化文本块（TDD §5.1：PC 名册+HP/SAN/关键状态+scene+facts） */
export const s2State: Stage = (ctx) => {
  const { stateBoard } = ctx.input;
  const lines: string[] = [`【状态板 v${stateBoard.version}】`];

  const { scene } = stateBoard;
  if (scene.name || scene.time || scene.publicDesc) {
    lines.push(`场景：${scene.name}${scene.time ? `｜${scene.time}` : ''}`);
    if (scene.publicDesc) lines.push(scene.publicDesc);
  }

  const pcEntries = Object.entries(stateBoard.pcs);
  if (pcEntries.length > 0) {
    lines.push('【PC 状态】');
    for (const [memberId, pc] of pcEntries) {
      const { sheet } = pc;
      lines.push(
        `- [${memberId}] ${sheet.playerName}（${sheet.occupation}）HP ${sheet.hp}｜MP ${sheet.mp}｜` +
          `SAN ${sheet.san}｜DB ${sheet.db}｜体格 ${sheet.build}｜状态：${pc.conditions.join('、') || '无'}`,
      );
    }
  }

  if (stateBoard.facts.length > 0) {
    lines.push('【已确立事实】');
    for (const fact of stateBoard.facts) lines.push(`- ${fact}`);
  }

  // 全空状态板不注入（刚开团/无状态可言）
  ctx.bundle.stateBlock = lines.length > 1 ? lines.join('\n') : '';
  return trace('S2-state', ctx.tokenizer.count(ctx.bundle.stateBlock), {
    stateBoardVersion: stateBoard.version,
    pcCount: pcEntries.length,
    factCount: stateBoard.facts.length,
    injected: ctx.bundle.stateBlock.length > 0,
  });
};

/** S3 世界书扫描：最近 scanDepth 条消息 → 命中条目集（TDD §5.2） */
export const s3WorldbookScan: Stage = (ctx) => {
  const scanned = ctx.input.messages.slice(-ctx.input.session.scanDepth);
  const hits = scanWorldBook(scanned.map(scanTextOf), ctx.input.worldBook);
  ctx.bundle.scanHits = hits;
  const scannedMessageCount = scanned.length;
  return trace('S3-worldbook-scan', 0, {
    scannedMessageCount,
    entryCount: ctx.input.worldBook.entries.length,
    hitUids: hits.map((h) => h.entry.uid),
    hits: hits.map((h) => ({
      uid: h.entry.uid,
      matchedKeys: h.matchedKeys,
      matchedSecondary: h.matchedSecondary,
      constant: h.entry.constant,
      kpOnly: h.entry.extensions?.kpOnly === true,
    })),
  });
};

/** S4 预算裁剪：命中条目按 weight 降序装入（同 weight 按 order 升序），超预算截断并记录 */
export const s4BudgetCut: Stage = (ctx) => {
  const { bundle, tokenizer } = ctx;
  const budget = ctx.input.session.worldBookBudgetTokens;
  const sorted = [...bundle.scanHits].sort(
    (a, b) => b.entry.weight - a.entry.weight || a.entry.order - b.entry.order,
  );

  const included: ScanHit[] = [];
  const dropped: ScanHit[] = [];
  let used = 0;
  for (const hit of sorted) {
    const cost = tokenizer.count(hit.entry.content);
    if (used + cost <= budget) {
      included.push(hit);
      used += cost;
    } else {
      dropped.push(hit);
    }
  }

  bundle.worldbookBlocks = included.map((hit) => ({
    uid: hit.entry.uid,
    position: hit.entry.position,
    depth: hit.entry.depth ?? null,
    order: hit.entry.order,
    content: hit.entry.content,
  }));
  return trace('S4-budget-cut', used, {
    budgetTokens: budget,
    includedUids: included.map((h) => h.entry.uid),
    droppedUids: dropped.map((h) => h.entry.uid),
    usedTokens: used,
  });
};

/** S5 历史裁剪核心：从全量消息取最近 keepCount 条（S7 回退重入） */
function runHistoryTrim(ctx: StageContext, keepCount: number): { trimmed: number } {
  const all = ctx.input.messages;
  ctx.bundle.history = keepCount >= all.length ? [...all] : all.slice(all.length - keepCount);
  return { trimmed: all.length - ctx.bundle.history.length };
}

/** S5 历史裁剪：取最近 maxHistoryMessages 条，被裁部分以梗概块替代（TDD §5.1 / 决议 D-01） */
export const s5HistoryTrim: Stage = (ctx) => {
  const { trimmed } = runHistoryTrim(ctx, ctx.input.session.maxHistoryMessages);
  // D-01：仅当确有历史被裁时才注入梗概（无裁剪时梗概无对应物）
  ctx.bundle.synopsis = trimmed > 0 ? ctx.input.synopsis : '';
  const historyText = ctx.bundle.history.map(formatMessageLine).join('\n');
  return trace('S5-history-trim', ctx.tokenizer.count(historyText), {
    total: ctx.input.messages.length,
    kept: ctx.bundle.history.length,
    trimmed,
    synopsisInjected: ctx.bundle.synopsis.length > 0,
  });
};

/** S6 组装核心（S7 回退重入）：条目按 position 插入 + 名册/梗概/历史（TDD §5.1） */
function runAssemble(ctx: StageContext): void {
  const { bundle, input } = ctx;
  const byOrder = (a: { order: number }, b: { order: number }): number => a.order - b.order;
  const beforeChar = bundle.worldbookBlocks
    .filter((b) => b.position === 'before_char')
    .sort(byOrder);
  const afterChar = bundle.worldbookBlocks.filter((b) => b.position === 'after_char').sort(byOrder);
  const atDepth = bundle.worldbookBlocks.filter((b) => b.position === 'at_depth').sort(byOrder);

  const systemParts: string[] = [];
  appendBlocks(systemParts, beforeChar);
  if (bundle.skeleton.length > 0) systemParts.push(bundle.skeleton);
  appendBlocks(systemParts, afterChar);
  if (bundle.stateBlock.length > 0) systemParts.push(bundle.stateBlock);

  // at_depth：depth = 距对话底部的消息条数（0 = 最末）；同深多条按 order 升序
  const historyLines = bundle.history.map(formatMessageLine);
  const inserts = new Map<number, string[]>();
  for (const block of atDepth) {
    const pos = Math.max(0, historyLines.length - (block.depth ?? 0));
    const texts = inserts.get(pos) ?? [];
    texts.push(block.content);
    inserts.set(pos, texts);
  }
  const merged: string[] = [];
  historyLines.forEach((line, i) => {
    merged.push(...(inserts.get(i) ?? []));
    merged.push(line);
  });
  // 最末插入点（depth=0）：pos === historyLines.length
  merged.push(...(inserts.get(historyLines.length) ?? []));

  const userParts: string[] = [];
  if (input.pcRoster.length > 0) userParts.push(`【PC 名册】\n${input.pcRoster}`);
  if (bundle.synopsis.length > 0) userParts.push(`【剧情梗概】\n${bundle.synopsis}`);
  if (merged.length > 0) userParts.push(`【对话历史】\n${merged.join('\n')}`);

  bundle.messages = [
    { role: 'system', content: systemParts.join('\n\n') },
    { role: 'user', content: userParts.join('\n\n') },
  ];
}

function appendBlocks(parts: string[], blocks: Array<{ content: string }>): void {
  if (blocks.length === 0) return;
  parts.push(blocks.map((b) => b.content).join('\n\n'));
}

/** S6 组装：system 骨架 + 状态块 + 世界书条目 + 名册/梗概/历史（TDD §5.1） */
export const s6Assemble: Stage = (ctx) => {
  runAssemble(ctx);
  const { bundle } = ctx;
  const tokenCount = bundle.messages.reduce((sum, m) => sum + ctx.tokenizer.count(m.content), 0);
  const blocks = bundle.worldbookBlocks;
  return trace('S6-assemble', tokenCount, {
    messageCount: bundle.messages.length,
    beforeCharUids: blocks.filter((b) => b.position === 'before_char').map((b) => b.uid),
    afterCharUids: blocks.filter((b) => b.position === 'after_char').map((b) => b.uid),
    atDepthEntries: blocks
      .filter((b) => b.position === 'at_depth')
      .map((b) => ({ uid: b.uid, depth: b.depth })),
  });
};

/** S7 校验：总 token ≤ 硬顶（上下文窗口 - 输出预留），超限回退 S5 再裁（TDD §5.1） */
export const s7Validate: Stage = (ctx) => {
  const { bundle, input, tokenizer } = ctx;
  const hardCap = input.session.contextWindowTokens - input.session.outputReserveTokens;
  const totalOf = (): number =>
    bundle.messages.reduce((sum, m) => sum + tokenizer.count(m.content), 0);

  let total = totalOf();
  let rounds = 0;
  let finalHistoryLength = bundle.history.length;
  let overBudget = false;

  // 回退：历史窗逐轮减半重裁（重入 S5/S6 核心），历史裁空仍超则标记超限照发
  while (total > hardCap && bundle.history.length > 0) {
    rounds += 1;
    const nextKeep = Math.floor(bundle.history.length / 2);
    const { trimmed } = runHistoryTrim(ctx, nextKeep);
    bundle.synopsis = trimmed > 0 ? input.synopsis : '';
    runAssemble(ctx);
    total = totalOf();
    finalHistoryLength = bundle.history.length;
    if (bundle.history.length === 0) break;
  }
  overBudget = total > hardCap;

  return trace('S7-validate', total, {
    totalTokens: total,
    hardCap,
    overBudget,
    fallbackRounds: rounds,
    finalHistoryLength,
  });
};

/** 消息 → 历史转写行的确定性格式（黄金用例快照依赖此形状） */
export function formatMessageLine(msg: Message): string {
  switch (msg.type) {
    case 'ic':
      return `[${msg.seq}][IC] ${msg.senderId}: ${msg.content}`;
    case 'ooc':
      return `[${msg.seq}][OOC/${msg.visibility}] ${msg.senderId}: ${msg.content}`;
    case 'system':
      return `[${msg.seq}][系统/${msg.subtype}] ${msg.content}`;
    case 'dice':
      return `[${msg.seq}][骰] ${msg.roll.expr} = ${msg.roll.total}${msg.hidden ? '（暗骰）' : ''}`;
    case 'narration':
      return `[${msg.seq}][KP] ${msg.content}`;
    case 'state_snapshot':
      return `[${msg.seq}][快照] 状态板版本 ${msg.stateBoard.version}`;
  }
}

/** 扫描文本提取：叙述类取 content；骰式与结构化状态不参与关键词匹配（数值噪声） */
function scanTextOf(msg: Message): string {
  switch (msg.type) {
    case 'ic':
    case 'ooc':
    case 'system':
    case 'narration':
      return msg.content;
    default:
      return '';
  }
}
