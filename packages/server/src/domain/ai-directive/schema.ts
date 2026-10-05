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

/** 5e 判定种类（FR-21）：AI 需指定攻击才能触发 nat20/nat1 面值规则 */
const DND5E_CHECK_KINDS = ['ability', 'save', 'attack', 'initiative'] as const;

export const CheckDirectiveSchema = z.strictObject({
  op: z.literal('check'),
  /** 检定目标 PC（谁掷骰取谁的技能值） */
  target: PcTargetSchema,
  /** 技能名，如「侦查」/「察觉」；数值不入指令 */
  skill: z.string().trim().min(1),
  /** 成功档位，缺省 normal（COC7 常规成功；5e 用来推定缺省 DC） */
  difficulty: z.enum(CHECK_DIFFICULTIES).default('normal'),
  /**
   * 5e 判定种类（缺省 ability）：显式给 attack 才会启用 nat20 必中 / nat1 必失。
   * COC7 忽略此字段（恒按技能检定判定）。
   */
  kind: z.enum(DND5E_CHECK_KINDS).optional(),
  /**
   * 5e 的目标值（DC；攻击时即 AC）。KP 不指定时按难度档推定（normal 10 / hard 15 / extreme 20）。
   * 这是「主持难度」而非判定结果，属 KP 叙事权，COC7 忽略。
   */
  dc: z.number().int().optional(),
  /** 展示用标签（DiceMsg 卡片标题，如「翻查书桌」） */
  label: z.string().trim().min(1).optional(),
});

export type CheckDirective = z.infer<typeof CheckDirectiveSchema>;

// ---- 数值效果指令（T-M8-03/04，FR-25/27，设计 §5.4）----

/** 伤害/治疗/损失表达式：AI 只给随机结构，面值由服务端 CSPRNG 掷出（数值不入指令） */
const ExprSchema = z.string().trim().min(1).max(64);

export const DamageDirectiveSchema = z.strictObject({
  op: z.literal('damage'),
  target: PcTargetSchema,
  /** 伤害表达式，如 1d8+2（服务端掷骰；不带判定后缀） */
  expr: ExprSchema,
  label: z.string().trim().min(1).optional(),
});

export const HealDirectiveSchema = z.strictObject({
  op: z.literal('heal'),
  target: PcTargetSchema,
  /** 治疗表达式，如 2d4+2（服务端掷骰） */
  expr: ExprSchema,
  label: z.string().trim().min(1).optional(),
});

export const SanityDirectiveSchema = z.strictObject({
  op: z.literal('sanity'),
  target: PcTargetSchema,
  /**
   * 损失表达式（KP 覆盖用）：缺省查规则书 sanityRule 房规损失表（按 SAN 检定结果定档）。
   * 显式给表达式时仍由服务端掷骰——KP 定规则、引擎出面值，数值不出自 AI。
   */
  loss: ExprSchema.optional(),
  label: z.string().trim().min(1).optional(),
});

export type DamageDirective = z.infer<typeof DamageDirectiveSchema>;
export type HealDirective = z.infer<typeof HealDirectiveSchema>;
export type SanityDirective = z.infer<typeof SanityDirectiveSchema>;

/**
 * 资源计数器变动（T-M12-02，FR-38）：如「消耗一环法术位」= delta -1。
 *
 * 与 damage/heal 的差别是本指令**不掷骰**——法术位/箭矢的消耗天然是确定的「几个」，
 * 没有随机结构可言。防篡改线的位置因此挪到别处：
 * - 只收**相对变动量** delta，不收 current/value/amount 等绝对数值字段（strictObject 拒）；
 * - 落板前一律 clamp(current+delta, 0, max)，AI 既不能把它顶穿上限也不能压成负数。
 * 换言之 AI 能表达「消耗一个」，但无法指定「现在剩几个」——服务端权威不变。
 */
export const ResourceDirectiveSchema = z.strictObject({
  op: z.literal('resource'),
  target: PcTargetSchema,
  /** 资源名，与状态板 PC 层 resources[].name 精确匹配 */
  name: z.string().trim().min(1),
  /** 变动量（正=恢复，负=消耗） */
  delta: z.number().int(),
  label: z.string().trim().min(1).optional(),
});

export type ResourceDirective = z.infer<typeof ResourceDirectiveSchema>;

/** AI 指令联合（op 白名单：check / damage / heal / sanity / resource） */
export type AiDirective =
  CheckDirective | DamageDirective | HealDirective | SanityDirective | ResourceDirective;
