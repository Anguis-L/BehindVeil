import {
  MessageSchema,
  StateBoardSchema,
  type CharacterCardV3,
  type Message,
  type StateBoard,
} from '@behindveil/shared';
import { JsonStore } from '../adapters/storage/json-store.js';
import { JsonlStore } from '../adapters/storage/jsonl-store.js';
import type { DataLayout } from '../adapters/storage/layout.js';
import { loadWorldBook } from '../domain/worldbook/validate.js';
import { readSession } from '../domain/session/sessions.js';
import { buildPrompt } from '../pipeline/index.js';
import { createHeuristicTokenizer } from '../pipeline/tokenizer.js';
import type { PipelineTrace } from '../pipeline/types.js';

/**
 * KP prompt 预览（T-M2-05，FR-13 / TDD §9）：以当前落盘状态组装 PipelineInput 并跑
 * 完整管线，返回全阶段 trace（kp:promptPreview 事件承载，host only）。
 *
 * M2 输入源：session/messages 取自仓库，世界书取房间级手编文件（D-08，载入校验），
 * 状态板读 session 初始 state.json（M5 状态板仓库落地后替换）；KP 卡为内置默认卡
 * （M5 模组包落地后由 moduleRef 解析）；pcRoster 桩空串（T-M5-04）。
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

export async function buildPreviewTrace(
  layout: DataLayout,
  roomId: string,
  sessionId: string,
  opts: PreviewOptions = {},
): Promise<PipelineTrace> {
  const session = await readSession(layout, roomId, sessionId);
  if (!session) throw new Error(`会话不存在：${sessionId}`);

  const messages = await readMessagesUpTo(layout, roomId, sessionId, opts.seq);
  const stateBoard = await readStateBoard(layout, roomId, sessionId);
  const { book } = await loadWorldBook(layout, roomId);

  return buildPrompt(
    {
      session: session.settings,
      kpCard: DEFAULT_KP_CARD,
      messages,
      stateBoard,
      worldBook: book,
      pcRoster: '',
      synopsis: session.synopsis,
    },
    createHeuristicTokenizer(),
  );
}

/** seq 升序的已落盘消息（seq ≤ upto；坏行跳过，与启动恢复同一容错口径） */
async function readMessagesUpTo(
  layout: DataLayout,
  roomId: string,
  sessionId: string,
  upto: number | undefined,
): Promise<Message[]> {
  const { records } = await new JsonlStore(layout.messagesFile(roomId, sessionId)).readAll();
  const messages: Message[] = [];
  for (const record of records) {
    const parsed = MessageSchema.safeParse(record);
    if (parsed.success && (upto === undefined || parsed.data.seq <= upto)) {
      messages.push(parsed.data);
    }
  }
  return messages.sort((a, b) => a.seq - b.seq);
}

/** 读 session 的 state.json；缺失或损坏时以空板兜底（M5 仓库化，预览不因状态板挂掉） */
async function readStateBoard(
  layout: DataLayout,
  roomId: string,
  sessionId: string,
): Promise<StateBoard> {
  const parsed = StateBoardSchema.safeParse(
    await new JsonStore(layout.stateFile(roomId, sessionId)).read(),
  );
  if (parsed.success) return parsed.data;
  return {
    version: 0,
    pcs: {},
    scene: { name: '', time: '', publicDesc: '' },
    facts: [],
    updatedAt: '1970-01-01T00:00:00.000Z',
  };
}
