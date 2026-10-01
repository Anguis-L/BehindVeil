import { z } from 'zod';

/**
 * 骰子契约（TDD §3.5、§5.3）。
 *
 * 不变式（CODING_STANDARDS §2.2）：数值只由服务端 CSPRNG 产生；
 * rolls 保存每组原始骰值，total/kept/check 均可由 expr+rolls 重算复现（决议 D-04）。
 * 判定后缀规格（CheckSpec）由骰式文法 `check` 项解析而来，规则书判定记录（RollCheck）
 * 由 RuleBook.adjudicate 填充，二者分开建模。
 */

/** 规则书标识。v1 首发仅 COC7；dnd5e 为二期（接口已按 ADR-04 预留） */
export const RULEBOOK_IDS = ['coc7', 'dnd5e'] as const;
export type RuleBookId = (typeof RULEBOOK_IDS)[number];

/**
 * 判定种类（TDD §3.5 check.kind）。
 * 前四种为 COC7；v2 追加 5e 四种（FR-21）：ability 属性检定 / save 豁免 / attack 攻击 / initiative 先攻。
 */
export const DICE_KINDS = [
  'skill',
  'sanity',
  'opposed',
  'luck',
  'ability',
  'save',
  'attack',
  'initiative',
] as const;
export type DiceKind = (typeof DICE_KINDS)[number];

/** 判定难度档（KP 要求的成功档位，TDD §3.5 / §5.4） */
export const CHECK_DIFFICULTIES = ['normal', 'hard', 'extreme'] as const;
export type CheckDifficulty = (typeof CHECK_DIFFICULTIES)[number];

/**
 * nat20 / nat1 的适用面（v2 FR-22 / ADR-2-02）。
 * attack_only（默认）= 跟官方：仅攻击骰强制 nat20 必中、nat1 必失；
 * all_d20 = 常见桌面房规：所有 d20 检定都适用。
 * 放在 dice.ts：判定记录要带它，审计复现才能重算出同样的结果。
 */
export const NAT20_RULES = ['attack_only', 'all_d20'] as const;
export type Nat20Rule = (typeof NAT20_RULES)[number];
/** 缺省值（旧数据/未指定时按官方口径） */
export const DEFAULT_NAT20_RULE: Nat20Rule = 'attack_only';

/** 判定结果四分类（TDD §3.5 check.outcome） */
export const CHECK_OUTCOMES = ['critical', 'success', 'fail', 'fumble'] as const;
export type CheckOutcome = (typeof CHECK_OUTCOMES)[number];

/**
 * 成功子等级（COC7 六档判定表承载，TDD §3.5 v1.2「对齐实现」）。
 * success 时表达达成的档位（normal/hard/extreme）；fail 时保留已达成的自然档位
 * （KP 要求的难度档未达，如「极难」要求下掷出困难区间——实现见 rulebook/coc7.ts）；
 * critical / fumble 恒为 normal。四分类 outcome 不足以表达 COC7 六档判定表，
 * 故以 outcome+grade 组合承载（困难/极难成功是 success 的子等级）。
 */
export const CHECK_GRADES = ['normal', 'hard', 'extreme'] as const;
export type CheckGrade = (typeof CHECK_GRADES)[number];

/** 骰式表达式（TDD §3.5）：解析产物以规范化字符串为准，raw 保留原输入 */
export const DiceExprSchema = z.object({
  raw: z.string(),
});
export type DiceExpr = z.infer<typeof DiceExprSchema>;

/** 判定后缀运算符（骰式文法 `check := expr ("<=" | ">=" | "=") number`） */
export const CHECK_OPS = ['<=', '>=', '='] as const;
export type CheckOp = (typeof CHECK_OPS)[number];

/** 判定后缀规格：骰式文法 `check := expr ("<=" | ">=" | "=") number` 的产物 */
export const CheckSpecSuffixSchema = z.object({
  op: z.enum(CHECK_OPS),
  target: z.number(),
});
export type CheckSpecSuffix = z.infer<typeof CheckSpecSuffixSchema>;

/** 规则书判定记录（RollResult.check，TDD §3.5） */
export const RollCheckSchema = z.object({
  rulebook: z.enum(RULEBOOK_IDS),
  kind: z.enum(DICE_KINDS),
  /** 判定目标值（技能值 / SAN 值 / 幸运值，或骰式后缀里的 target） */
  target: z.number(),
  difficulty: z.enum(CHECK_DIFFICULTIES),
  outcome: z.enum(CHECK_OUTCOMES),
  /** 成功子等级：success 表达成档位、fail 保留自然档位；可省略（缺省视为 normal，布尔判定不带） */
  grade: z.enum(CHECK_GRADES).optional(),
  /**
   * 判定运算符（2026-09-25 拍板方案 a，T-M4-02 落地）：缺省即 `<=`（走规则书判定表）。
   * `>=` / `=` 无规则书语义，走通用布尔比较，outcome 仅 success/fail 且不带 grade
   * （如 5e 的 `1d20+5>=13`）。
   */
  op: z.enum(CHECK_OPS).optional(),
  /**
   * 判定时的 nat20 适用面（5e；v2 FR-22）。
   * 它是判定的直接输入（同一骰值在不同开关下可能是大成功或普通成功），
   * 故随判定记录落审计流水——否则非默认房规的骰子复现会误报不一致。
   */
  nat20Rule: z.enum(NAT20_RULES).optional(),
});
export type RollCheck = z.infer<typeof RollCheckSchema>;

/**
 * 审计字段（TDD §3.5 audit）。
 * 字段名按施工文档决议 D-04 的默认方案取 `rollId`（CSPRNG 无种子、不可重放，
 * 「复现」= 由流水中的 expr+rolls 重算 total/kept/check）。D-04 待用户拍板；
 * 若拍板否决，改回 TDD v1 原名 `engineSeedId` 即可。
 */
export const RollAuditSchema = z.object({
  /** 审计流水号，全局唯一（data/logs/audit-dice.jsonl，T-M4-01 落地） */
  seq: z.string(),
  /** 掷骰时刻 ISO8601 */
  ts: z.string(),
  /** 本次掷骰标识（见上 D-04 说明） */
  rollId: z.string(),
});
export type RollAudit = z.infer<typeof RollAuditSchema>;

/**
 * 掷骰结果（TDD §3.5）。
 * audit 必填：M4 起所有掷骰（玩家骰与 AI 检定骰）一律先落审计流水再广播，
 * 没有审计号的骰子不允许进入消息流（出站 Schema 自检会拦下）。
 */
export const RollResultSchema = z.object({
  /** 规范化表达式，如 "1d100"、"3d6kh2"、"2d6+3<=8" */
  expr: z.string(),
  /** 每个骰组的原始骰值（命运骰取值 -1/0/1），审计重算的输入之一 */
  rolls: z.array(z.array(z.number())),
  /** 保留值（应用 kh/kl/dh/dl 后，按骰组顺序平铺） */
  kept: z.array(z.number()),
  total: z.number(),
  check: RollCheckSchema.optional(),
  audit: RollAuditSchema,
});
export type RollResult = z.infer<typeof RollResultSchema>;
