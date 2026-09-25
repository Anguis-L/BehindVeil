import { z } from 'zod';

/**
 * 领域模型骨架（TDD §3.1 Room/Session、§3.3 角色卡、§3.4 世界书、§3.7 状态板）。
 *
 * 本文件是 T-M0-02「契约先行」的骨架交付：Schema 即类型源（z.infer），
 * 后续里程碑按章节细化——世界书完整 Schema 于 T-M2-01 抽到独立 worldbook.ts，
 * 模组包 Schema 于 T-M5-05 落 module.ts，此处不提前展开。
 */

// ---- Room / Session（§3.1）----

export const MemberRoleSchema = z.enum(['host', 'player', 'observer']);
export type MemberRole = z.infer<typeof MemberRoleSchema>;

/** 房间成员（members.json，TDD §3.1/§6） */
export const MemberSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: MemberRoleSchema,
  /** ISO8601 */
  joinedAt: z.string(),
});
export type Member = z.infer<typeof MemberSchema>;

/** 会话级 LLM/管线设置（TDD §3.1 settings）。全字段必填：裁剪窗/预算/扫描深度缺失会让管线行为失义 */
export const SessionSettingsSchema = z.object({
  provider: z.string(),
  model: z.string(),
  temperature: z.number().min(0).max(2),
  /** 历史裁剪窗（默认 40，由创建方填入） */
  maxHistoryMessages: z.number().int().positive(),
  /** 世界书预算（默认 2000，由创建方填入） */
  worldBookBudgetTokens: z.number().int().nonnegative(),
  /** 世界书扫描深度（默认 4，由创建方填入） */
  scanDepth: z.number().int().positive(),
});
export type SessionSettings = z.infer<typeof SessionSettingsSchema>;

export const RoomSchema = z.object({
  /** nanoid(12)，T-M1-01/M1 REST 建房时生成 */
  id: z.string(),
  name: z.string(),
  /** ISO8601 */
  createdAt: z.string(),
  /** 6 位邀请码，Host 可重置（TDD §8） */
  inviteCode: z.string().length(6),
  activeSessionId: z.string().nullable(),
  memberLimit: z.number().int().positive(),
  /**
   * 本房默认会话设置（docs/openapi RoomSettingsPatch）：只影响之后新建的会话，
   * 不改写已存在 Session 的 settings；缺省时由 session:start 显式给出。
   */
  defaultSessionSettings: SessionSettingsSchema.optional(),
});
export type Room = z.infer<typeof RoomSchema>;

export const SessionSchema = z.object({
  id: z.string(),
  roomId: z.string(),
  /** module id + version（§3.6） */
  moduleRef: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  /** 状态板乐观锁版本号（§3.7 / E-ST-01） */
  stateBoardVersion: z.number().int().nonnegative(),
  settings: SessionSettingsSchema,
  /**
   * 剧情梗概（决议 D-01 默认方案）：历史裁剪后被裁部分以梗概块替代，
   * v1 由 Host 直接手编本文件维护，载入时过 Schema 校验，无运行时编辑 UI。
   */
  synopsis: z.string().default(''),
});
export type Session = z.infer<typeof SessionSchema>;

// ---- PCSheet / StateBoard（§3.3 / §3.7）----

/** COC7 调查员速览（注入名册用） */
export const PCSheetSchema = z.object({
  playerName: z.string(),
  occupation: z.string(),
  str: z.number(),
  con: z.number(),
  siz: z.number(),
  dex: z.number(),
  app: z.number(),
  int: z.number(),
  pow: z.number(),
  edu: z.number(),
  luck: z.number(),
  hp: z.number(),
  mp: z.number(),
  san: z.number(),
  db: z.string(),
  build: z.string(),
  /** { "侦查": 60, "图书馆使用": 50 } */
  skills: z.record(z.string(), z.number()),
});
export type PCSheet = z.infer<typeof PCSheetSchema>;

export const StateBoardPcSchema = z.object({
  sheet: PCSheetSchema,
  /** 如 ["疯狂(临时)", "重伤"] */
  conditions: z.array(z.string()),
});
export type StateBoardPc = z.infer<typeof StateBoardPcSchema>;

export const StateBoardSceneSchema = z.object({
  name: z.string(),
  time: z.string(),
  publicDesc: z.string(),
});
export type StateBoardScene = z.infer<typeof StateBoardSceneSchema>;

/** PC 数值权威状态（§3.7）。任何数值以状态板为准；每次变更产生事件（TDD §5.5） */
export const StateBoardSchema = z.object({
  /** 乐观锁版本 */
  version: z.number().int().nonnegative(),
  /** key = memberId */
  pcs: z.record(z.string(), StateBoardPcSchema),
  scene: StateBoardSceneSchema,
  /** 已确立事实（Host 可维护，注入 prompt） */
  facts: z.array(z.string()),
  updatedAt: z.string(),
});
export type StateBoard = z.infer<typeof StateBoardSchema>;

// ---- WorldBook（§3.4，与 ST 字段语义对齐）----

/** 0=AND_ANY 1=NOT_ALL 2=NOT_ANY 3=AND_ALL */
export const SELECTIVE_LOGICS = [0, 1, 2, 3] as const;
export type SelectiveLogic = (typeof SELECTIVE_LOGICS)[number];

export const WORLD_BOOK_POSITIONS = ['before_char', 'after_char', 'at_depth'] as const;
export type WorldBookPosition = (typeof WORLD_BOOK_POSITIONS)[number];

export const WorldBookEntrySchema = z.object({
  uid: z.number().int(),
  /** 主关键词，支持 /regex/ 形式 */
  key: z.array(z.string()),
  keysecondary: z.array(z.string()),
  selectiveLogic: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  content: z.string(),
  position: z.enum(WORLD_BOOK_POSITIONS),
  /** position=at_depth 时生效 */
  depth: z.number().int().nonnegative().optional(),
  /** 同优先级排序 */
  order: z.number().int(),
  /** 默认 100；预算不足时高权重保留（T-M2-03 裁剪依据） */
  weight: z.number().default(100),
  /** true = 常驻注入 */
  constant: z.boolean(),
  disabled: z.boolean(),
  /** aidle 扩展：kpOnly 条目 = 模组真相，注入 prompt 但不得出现在非 Host 可见输出（TDD §8） */
  extensions: z
    .object({
      kpOnly: z.boolean().optional(),
    })
    .optional(),
});
export type WorldBookEntry = z.infer<typeof WorldBookEntrySchema>;

export const WorldBookSchema = z.object({
  entries: z.array(WorldBookEntrySchema),
});
export type WorldBook = z.infer<typeof WorldBookSchema>;

// ---- CharacterCardV3（§3.3，ccv3 兼容映射，ADR-06）----

export const AidleCardExtensionsSchema = z.object({
  rulebook: z.enum(['coc7', 'dnd5e']),
  /** 玩家卡时携带 */
  pcSheet: PCSheetSchema.optional(),
});
export type AidleCardExtensions = z.infer<typeof AidleCardExtensionsSchema>;

export const CharacterCardV3Schema = z.object({
  spec: z.literal('chara_card_v3'),
  data: z.object({
    name: z.string(),
    /** KP 卡：行为准则 + 判定规则 */
    description: z.string(),
    scenario: z.string(),
    first_mes: z.string(),
    mes_example: z.string(),
    /** 卡内嵌世界书 */
    character_book: WorldBookSchema.optional(),
    extensions: z.looseObject({
      /** ccv3 允许任意扩展键，社区卡字段原样保留（T-M5-01 导入导出细化） */
      aidle: AidleCardExtensionsSchema.optional(),
    }),
  }),
});
export type CharacterCardV3 = z.infer<typeof CharacterCardV3Schema>;
