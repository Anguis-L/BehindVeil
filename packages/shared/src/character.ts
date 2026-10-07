import { z } from 'zod';
import { RULEBOOK_IDS, type GenericRule, type RuleBookId } from './dice.js';
import { CharacterCardV3Schema, type CharacterCardV3, type PCSheet } from './domain.js';

/**
 * 角色卡 M5 契约（T-M5-01/03/09，FR-08，TDD §3.3）。
 *
 * 只放 M5 新增的部分；ccv3 主体 `CharacterCardV3Schema` 仍在 domain.ts（M0 契约先行时落地）。
 * 前后端共享：web 的导入 UI 与卡库列表直接消费这里的推导类型。
 */

/** 三步导入流（SDD §3.2 M5 行）：检测 → 转换 → 验证 */
export const CARD_IMPORT_STEPS = ['detect', 'convert', 'validate'] as const;
export type CardImportStep = (typeof CARD_IMPORT_STEPS)[number];

/** 卡的来源规格：ccv3 原生，或 ccv2 经转换而来（供 UI 提示与测试断言） */
export const CARD_SOURCES = ['ccv3', 'ccv2'] as const;
export type CardSource = (typeof CARD_SOURCES)[number];

export const CardImportSuccessSchema = z.object({
  ok: z.literal(true),
  source: z.enum(CARD_SOURCES),
  card: CharacterCardV3Schema,
});
export type CardImportSuccess = z.infer<typeof CardImportSuccessSchema>;

/** 失败必须定位到步（TC-FR-08-005：三分支失败均可诊断） */
export const CardImportFailureSchema = z.object({
  ok: z.literal(false),
  step: z.enum(CARD_IMPORT_STEPS),
  code: z.literal('E-CARD-01'),
  message: z.string(),
});
export type CardImportFailure = z.infer<typeof CardImportFailureSchema>;

export const CardImportResultSchema = z.discriminatedUnion('ok', [
  CardImportSuccessSchema,
  CardImportFailureSchema,
]);
export type CardImportResult = z.infer<typeof CardImportResultSchema>;

/** v2 旧卡（chara_card_v2 / 无 spec 的扁平卡）：字段宽松，仅用于识别与转换 */
export const CharacterCardV2Schema = z.looseObject({
  spec: z.literal('chara_card_v2').optional(),
  spec_version: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  personality: z.string().optional(),
  scenario: z.string().optional(),
  first_mes: z.string().optional(),
  mes_example: z.string().optional(),
  creator_notes: z.string().optional(),
  /** v1/v2 的双层形态：字段也可能压在 data 里 */
  data: z.looseObject({}).optional(),
});
export type CharacterCardV2 = z.infer<typeof CharacterCardV2Schema>;

/** 卡的来源文件形态（FR-08 双格式） */
export const CARD_FILE_SOURCES = ['json', 'png'] as const;
export type CardFileSource = (typeof CARD_FILE_SOURCES)[number];

/**
 * 卡库条目（T-M5-09，字段与 docs/openapi.yaml 的 CardSummary 对齐）。
 * `id` = 落盘文件名（已做路径穿越防护），删除/取全文用它定位文件。
 */
export const CardEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  spec: z.literal('chara_card_v3'),
  /** 无 aidle 扩展时为 null（社区卡常见）——不编造规则书，由 UI 提示用户补 */
  rulebook: z.enum(RULEBOOK_IDS).nullable(),
  /** 带 pcSheet 即为玩家卡，否则是 KP 卡 */
  kind: z.enum(['kp', 'pc']),
  source: z.enum(CARD_FILE_SOURCES),
  updatedAt: z.string(),
});
export type CardEntry = z.infer<typeof CardEntrySchema>;

/** 上传请求：原样落盘的卡片内容（PNG/JSON 均走 base64，避免引入 multipart 依赖） */
export const CardUploadSchema = z.object({
  fileName: z.string().min(1).max(120),
  contentBase64: z.string().min(1),
});
export type CardUpload = z.infer<typeof CardUploadSchema>;

export interface CardExtensions {
  /** 无 aidle 扩展时为 null（社区卡常见） */
  rulebook: RuleBookId | null;
  /** rulebook='generic' 时的判定配置（FR-40）；其他情况 null */
  genericRule: GenericRule | null;
  /** 玩家卡的 PC 数值；KP 卡为 null */
  pcSheet: PCSheet | null;
}

/** 从 ccv3 卡取 aidle 扩展，供名册/状态板判定规则书与 PC 数值 */
export function readCardExtensions(card: CharacterCardV3): CardExtensions {
  const aidle = card.data.extensions.aidle;
  return {
    rulebook: aidle?.rulebook ?? null,
    genericRule: aidle?.genericRule ?? null,
    pcSheet: aidle?.pcSheet ?? null,
  };
}
