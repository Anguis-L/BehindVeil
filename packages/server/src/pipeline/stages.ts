import type { Message, WorldBookPosition } from '@behindveil/shared';
import type { LlmMessage } from '../domain/llm.js';
import type { Tokenizer } from './tokenizer.js';
import type { JsonValue, PipelineInput, StageName, StageTrace } from './types.js';

/**
 * S1–S7 阶段实现（T-M0-07，TDD §5.1 阶段顺序）。
 *
 * M0 交付的是阶段框架：每阶段已是独立纯函数、顺序执行并记录 trace，
 * 但领域逻辑按里程碑落位——世界书扫描 @todo T-M2-02、预算裁剪 @todo T-M2-03、
 * 状态注入块/历史裁剪+梗概/硬顶回退 @todo T-M2-04。空实现均返回确定性的空产物，
 * 黄金用例（tests/golden/）以此为 M0 基线快照。
 */

/** S1 元指令（TDD §5.1：「数值以状态板为准」；检定协议声明对应 §5.4） */
export const META_INSTRUCTION =
  '数值与状态一律以状态板为准；需要检定时输出 aidle 指令块向引擎请求，不得自行产生数值或宣告判定结果。';

/** 阶段间传递的中间产物 */
export interface PipelineBundle {
  /** S1：system 骨架（KP 人格 + 规则速查 + 元指令） */
  skeleton: string;
  /** S2：状态板注入块 */
  stateBlock: string;
  /** S3/S4：命中且通过预算的世界书条目（M0 恒为空） */
  worldbookBlocks: Array<{
    uid: number;
    position: WorldBookPosition;
    depth: number | null;
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
  // @todo T-M2-04/M3：规则书速查注入（随规则书接入管线）
  sections.push(META_INSTRUCTION);
  ctx.bundle.skeleton = sections.join('\n\n');
  return trace('S1-skeleton', ctx.tokenizer.count(ctx.bundle.skeleton), {
    sections: [...(persona.trim().length > 0 ? ['kp-persona'] : []), 'meta-instruction'],
  });
};

/** S2 状态注入：stateBoard → 结构化文本块（TDD §5.1） */
export const s2State: Stage = (ctx) => {
  const { stateBoard } = ctx.input;
  // @todo T-M2-04：PC 名册 + HP/SAN/关键状态 + scene + facts 的结构化注入块
  ctx.bundle.stateBlock = '';
  return trace('S2-state', 0, {
    stateBoardVersion: stateBoard.version,
    pcCount: Object.keys(stateBoard.pcs).length,
    factCount: stateBoard.facts.length,
  });
};

/** S3 世界书扫描：最近 scanDepth 条消息 → 命中条目集（TDD §5.2） */
export const s3WorldbookScan: Stage = (ctx) => {
  const scannedMessageCount = Math.min(ctx.input.session.scanDepth, ctx.input.messages.length);
  // @todo T-M2-02：scanWorldBook（子串+/regex/、四种 selectiveLogic、constant、kpOnly、递归 1 层）
  ctx.bundle.worldbookBlocks = [];
  return trace('S3-worldbook-scan', 0, {
    scannedMessageCount,
    entryCount: ctx.input.worldBook.entries.length,
    hitUids: [] as number[],
  });
};

/** S4 预算裁剪：命中条目按 weight 降序装入，超预算截断并记录（TDD §5.1） */
export const s4BudgetCut: Stage = (ctx) => {
  // @todo T-M2-03：预算裁剪（被裁条目记录进 trace）
  return trace('S4-budget-cut', 0, {
    budgetTokens: ctx.input.session.worldBookBudgetTokens,
    includedUids: [] as number[],
    droppedUids: [] as number[],
  });
};

/** S5 历史裁剪：取最近 maxHistoryMessages 条，被裁部分以梗概块替代（TDD §5.1 / 决议 D-01） */
export const s5HistoryTrim: Stage = (ctx) => {
  const all = ctx.input.messages;
  // @todo T-M2-04：裁剪窗 + 梗概块（synopsis 来源：session.synopsis，Host 手编）
  ctx.bundle.history = [...all];
  ctx.bundle.synopsis = '';
  return trace('S5-history-trim', ctx.tokenizer.count(all.map(formatMessageLine).join('\n')), {
    total: all.length,
    kept: ctx.bundle.history.length,
    trimmed: all.length - ctx.bundle.history.length,
  });
};

/** S6 组装：system 骨架 + 状态块 + 世界书条目 + 名册/梗概/历史（TDD §5.1） */
export const s6Assemble: Stage = (ctx) => {
  const { bundle, input } = ctx;
  const systemParts = [bundle.skeleton, bundle.stateBlock].filter((s) => s.length > 0);
  // @todo T-M2-04：世界书条目按 position（before_char/after_char/at_depth）插入
  const worldbookText = bundle.worldbookBlocks.map((b) => b.content).join('\n\n');
  if (worldbookText.length > 0) systemParts.push(worldbookText);

  const userParts: string[] = [];
  if (input.pcRoster.length > 0) userParts.push(`【PC 名册】\n${input.pcRoster}`);
  if (bundle.synopsis.length > 0) userParts.push(`【剧情梗概】\n${bundle.synopsis}`);
  if (bundle.history.length > 0) {
    userParts.push(`【对话历史】\n${bundle.history.map(formatMessageLine).join('\n')}`);
  }

  bundle.messages = [
    { role: 'system', content: systemParts.join('\n\n') },
    { role: 'user', content: userParts.join('\n\n') },
  ];
  const tokenCount = bundle.messages.reduce((sum, m) => sum + ctx.tokenizer.count(m.content), 0);
  return trace('S6-assemble', tokenCount, { messageCount: bundle.messages.length });
};

/** S7 校验：总 token ≤ 硬顶（模型上下文 - 输出预留），超限回退 S5 再裁（TDD §5.1） */
export const s7Validate: Stage = (ctx) => {
  const totalTokens = ctx.bundle.messages.reduce(
    (sum, m) => sum + ctx.tokenizer.count(m.content),
    0,
  );
  // @todo T-M2-04：硬顶校验与回退（硬顶 = 模型上下文 - 输出预留，M2 引入配置）
  return trace('S7-validate', totalTokens, { totalTokens, hardCap: null, overBudget: false });
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
