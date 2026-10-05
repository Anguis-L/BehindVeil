import type { CharacterCardV3 } from '@behindveil/shared';
import type { DataLayout } from '../adapters/storage/layout.js';
import { loadWorldBook } from '../domain/worldbook/validate.js';
import {
  DEFAULT_VECTOR_RECALL_K,
  DEFAULT_VECTOR_RECALL_THRESHOLD,
  prepareVectorRecall,
  type EmbedFn,
} from '../domain/worldbook/recall.js';
import { scanTextOf } from '../pipeline/stages.js';
import { readStateBoard } from '../domain/stateboard/board.js';
import { readMessagesUpTo } from '../domain/session/messages.js';
import { readSession } from '../domain/session/sessions.js';
import { buildPrompt } from '../pipeline/index.js';
import { createHeuristicTokenizer } from '../pipeline/tokenizer.js';
import type { PipelineInput, PipelineTrace } from '../pipeline/types.js';

/**
 * KP prompt 预览（T-M2-05，FR-13 / TDD §9）：以当前落盘状态组装 PipelineInput 并跑
 * 完整管线，返回全阶段 trace（kp:promptPreview 事件承载，host only）。
 *
 * 输入源：session/messages 取自仓库，世界书取房间级手编文件（D-08，载入校验），
 * 状态板经状态板仓库读取（T-M5-06 board.ts，缺失/损坏空板兜底）；KP 卡为内置默认卡
 * （模组包 KP 卡解析随 T-M5-05 收尾接入）；pcRoster 桩空串（PC 名册块随 T-M5-10 评估）。
 */

/** M2 内置默认 KP 卡：卡库/模组系统（M5）落地前的人格兜底，规则书默认 COC7 */
export const DEFAULT_KP_CARD: CharacterCardV3 = {
  spec: 'chara_card_v3',
  data: {
    name: '守秘人',
    description: '你是本团守秘人（KP）：负责叙事推进与扮演 NPC，引导玩家调查与决策。',
    scenario: '',
    first_mes: '',
    mes_example: '',
    extensions: { aidle: { rulebook: 'coc7' } },
  },
};

export interface PreviewOptions {
  /** 指定历史 seq 的预览（TC-FR-13-002）：仅取 seq ≤ 该值的消息；缺省取全量 */
  seq?: number;
}

/**
 * 向量召回上下文（v3 FR-33）：嵌入函数由装配根注入（llm.embedding 已配置才有）。
 * 缺省 = 向量召回关闭，PipelineInput 无 vectorRecall → S3.5 跳过（行为 = v2.0）。
 */
export interface RecallContext {
  embed: EmbedFn;
}

export async function buildPreviewTrace(
  layout: DataLayout,
  roomId: string,
  sessionId: string,
  opts: PreviewOptions = {},
  recall?: RecallContext,
): Promise<PipelineTrace> {
  const session = await readSession(layout, roomId, sessionId);
  if (!session) throw new Error(`会话不存在：${sessionId}`);

  const messages = await readMessagesUpTo(layout, roomId, sessionId, opts.seq);
  const stateBoard = await readStateBoard(layout, roomId, sessionId);
  const { book } = await loadWorldBook(layout, roomId);

  // S3.5 向量召回（T-M11-03）：查询语料与关键词扫描同源（最近 scanDepth 条叙述文本）
  let vectorRecall: PipelineInput['vectorRecall'];
  if (recall?.embed) {
    const outcome = await prepareVectorRecall({
      layout,
      roomId,
      book,
      queryTexts: messages.slice(-session.settings.scanDepth).map(scanTextOf),
      k: session.settings.vectorRecallK ?? DEFAULT_VECTOR_RECALL_K,
      threshold: session.settings.vectorRecallThreshold ?? DEFAULT_VECTOR_RECALL_THRESHOLD,
      embed: recall.embed,
    });
    if (outcome) {
      vectorRecall = {
        hits: outcome.hits,
        meta: outcome.meta,
        ...(outcome.degraded ? { degraded: true, degradedReason: outcome.degradedReason } : {}),
      };
    }
  }

  return buildPrompt(
    {
      session: session.settings,
      kpCard: DEFAULT_KP_CARD,
      messages,
      stateBoard,
      worldBook: book,
      pcRoster: '',
      synopsis: session.synopsis,
      ...(vectorRecall ? { vectorRecall } : {}),
    },
    createHeuristicTokenizer(),
  );
}
