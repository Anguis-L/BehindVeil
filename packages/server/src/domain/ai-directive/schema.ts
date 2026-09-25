import { CHECK_DIFFICULTIES } from '@behindveil/shared';
import { z } from 'zod';

/**
 * AI 指令块 Schema（T-M3-01，TDD §5.4）。
 *
 * AI 叙事流中 ```aidle fenced 块承载的 JSON 对象。v1 op 白名单仅 `check`（T-M3-02）：
 * AI 只传技能名与目标 PC，不传任何数值——技能值由服务端从状态板/名册取
 * （CODING_STANDARDS §2.2 服务端权威，TC-FR-05-008 防篡改）。
 * strictObject 拒绝未知字段：AI 夹带 skillValue 等数值字段直接白名单拒绝，不掷骰。
 */

/** PC 目标引用：`pc:` 前缀 + 非空标识。前缀校验在此，存在性校验归检定执行器（名册查无此人时报错） */
const PcTargetSchema = z
  .string()
  .trim()
  .regex(/^pc:.+$/, 'target 必须是 "pc:<标识>" 形式');

export const CheckDirectiveSchema = z.strictObject({
  op: z.literal('check'),
  /** 检定目标 PC（谁掷骰取谁的技能值） */
  target: PcTargetSchema,
  /** 技能名，如「侦查」；数值不入指令 */
  skill: z.string().trim().min(1),
  /** 成功档位，缺省 normal（COC7 常规成功） */
  difficulty: z.enum(CHECK_DIFFICULTIES).default('normal'),
  /** 展示用标签（DiceMsg 卡片标题，如「翻查书桌」） */
  label: z.string().trim().min(1).optional(),
});

export type CheckDirective = z.infer<typeof CheckDirectiveSchema>;
