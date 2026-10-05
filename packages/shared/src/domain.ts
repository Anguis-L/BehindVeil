import { z } from 'zod';
import { NAT20_RULES, RULEBOOK_IDS } from './dice.js';

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
export const SessionSettingsSchema = z
  .object({
    provider: z.string(),
    model: z.string(),
    temperature: z.number().min(0).max(2),
    /**
     * nat20/nat1 适用面（5e；COC 不使用，随会话设置一并持久化）。
     * 可选而非 default：旧会话数据无此字段时保持缺失、不改写落盘结构，消费侧按 DEFAULT_NAT20_RULE 兜底。
     */
    nat20Rule: z.enum(NAT20_RULES).optional(),
    /** 历史裁剪窗（默认 40，由创建方填入） */
    maxHistoryMessages: z.number().int().positive(),
    /** 世界书预算（默认 2000，由创建方填入） */
    worldBookBudgetTokens: z.number().int().nonnegative(),
    /** 世界书扫描深度（默认 4，由创建方填入） */
    scanDepth: z.number().int().positive(),
    /**
     * 模型上下文窗口与输出预留（S7 硬顶 = contextWindowTokens - outputReserveTokens，
     * TDD §5.1 S7；硬顶须随黄金用例输入驱动回退，故进会话级设置。默认按 32K 级模型）。
     */
    contextWindowTokens: z.number().int().positive().default(32_768),
    outputReserveTokens: z.number().int().positive().default(2_048),
    /**
     * 向量召回 topK（v3 FR-33，可选而非 default：旧会话数据无此字段时保持缺失、
     * 不改写落盘结构，消费侧按 DEFAULT_VECTOR_RECALL_K=8 兜底）。
     */
    vectorRecallK: z.number().int().min(1).max(64).optional(),
    /** 向量召回相似度阈值（余弦下限）；消费侧按 DEFAULT_VECTOR_RECALL_THRESHOLD=0.78 兜底 */
    vectorRecallThreshold: z.number().min(0).max(1).optional(),
    /**
     * AI 剧情梗概开关（v3 FR-36，ADR-3-09）：S5 裁剪发生后链外生成梗概提案，
     * Host 确认后回写 session.synopsis。缺省关（v3 首期灰度，NFR-11 默认配置零负担）。
     */
    aiSynopsis: z.boolean().optional(),
  })
  // S7 硬顶 = context - reserve（TDD §5.1）：配置颠倒会让硬顶为负、历史裁空仍超限
  .refine((s) => s.contextWindowTokens > s.outputReserveTokens, {
    message: 'contextWindowTokens 必须大于 outputReserveTokens（S7 硬顶 = 二者之差）',
  });
export type SessionSettings = z.infer<typeof SessionSettingsSchema>;

/** Host 身份锚定方式（T-M8-06，FR-26）：token=建房者凭 hostToken（v1）；member=转让后凭成员角色标记 */
export const HOST_AUTH_MODES = ['token', 'member'] as const;
export type HostAuthMode = (typeof HOST_AUTH_MODES)[number];

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
   * Host 转让标记（T-M8-06）：可选而非 default——v1 room.json 无此字段，按 'token' 处理
   * （消费侧归一）。'member' 时 Host 重连凭 members.json 角色标记 + memberId 恢复（旧 token 已轮换失效）。
   */
  hostAuth: z.enum(HOST_AUTH_MODES).optional(),
  /**
   * 副 Host（T-M8-06，FR-26）：房间级角色标记（一名），获得快照/状态编辑权限；
   * 不发新 token。可选而非 default：v1 room.json 无此字段，按无副 Host 处理。
   */
  coHostMemberId: z.string().nullable().optional(),
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
  /**
   * 本会话采用的规则书（v2 FR-20 / 设计 §5.1）：一房一规则书，开团时由模组决定。
   * 可选而非 default：v1 存量 session.json 无此字段，按 coc7 处理（消费侧归一）。
   */
  rulebook: z.enum(RULEBOOK_IDS).optional(),
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

/**
 * COC7 调查员卡（v1 原样保留，仅加判别字段）。
 * `rulebook` 带 default：v1 存量数据与旧角色卡无此字段，解析时自动补 coc7（实测 discriminatedUnion 会应用 default，
 * 故存量 state.json 零迁移）。
 */
export const Coc7SheetSchema = z.object({
  rulebook: z.literal('coc7').default('coc7'),
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
export type Coc7Sheet = z.infer<typeof Coc7SheetSchema>;

/** 5e 六维（属性值，不是调整值——调整值由服务端现算，见 roster） */
export const DND5E_ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
export type Dnd5eAbility = (typeof DND5E_ABILITIES)[number];

/** D&D 5e 角色卡（v2 FR-24）：只存「原始数值」，一切修正值由服务端现算 */
export const Dnd5eSheetSchema = z.object({
  rulebook: z.literal('dnd5e'),
  playerName: z.string(),
  /** 职业与种族（展示与名册用；内容不内置，由模组/卡自己给） */
  occupation: z.string().default(''),
  abilities: z.object({
    str: z.number(),
    dex: z.number(),
    con: z.number(),
    int: z.number(),
    wis: z.number(),
    cha: z.number(),
  }),
  /** 熟练加值（随等级走，卡里写死，服务端不推导等级） */
  proficiencyBonus: z.number(),
  ac: z.number(),
  hp: z.object({ max: z.number(), current: z.number() }),
  /** 熟练技能名（与技能表对齐，取值时按名匹配属性） */
  proficientSkills: z.array(z.string()).default([]),
  /** 熟练豁免（六维键） */
  proficientSaves: z.array(z.enum(DND5E_ABILITIES)).default([]),
});
export type Dnd5eSheet = z.infer<typeof Dnd5eSheetSchema>;

/** 角色卡判别联合：按 rulebook 分流两套字段体系 */
export const PCSheetSchema = z.discriminatedUnion('rulebook', [Coc7SheetSchema, Dnd5eSheetSchema]);
export type PCSheet = z.infer<typeof PCSheetSchema>;

/**
 * 状态条目（v3 FR-39）：由裸字符串升级为对象，承载「说明」与「到期提示」。
 * 迁移器首个真实用例——v1 的 `string` 由 state 链 v1→v2 节点升为 `{ label }`。
 */
export const ConditionSchema = z.object({
  /** 状态名，如「重伤」「疯狂(临时)」 */
  label: z.string(),
  /** 补充说明，如「左腿，行动 -20%」 */
  note: z.string().optional(),
  /** 到期提示（人读文本，不做任何自动解除——看板红线），如「3 回合后」「长休后」 */
  expiresHint: z.string().optional(),
});
export type Condition = z.infer<typeof ConditionSchema>;

/**
 * 状态条目的单行文本：note 以括号附注。
 * expiresHint 刻意不入——它是给 Host 看的到期提示（看板红线：不做自动解除），
 * 进 prompt 只会涨 token 且诱导 AI 自行到期。UI 与导出各自按需展示。
 */
export function conditionText(condition: Condition): string {
  return condition.note ? `${condition.label}（${condition.note}）` : condition.label;
}

/**
 * 通用资源计数器（v3 FR-38 / ADR-3-07）：法术位、弹药、理智点余量之类「有上限的消耗品」。
 * 挂在状态板 PC 层（与 conditions 并列）而非 PCSheet——规则书不感知、机制通用，
 * 且避免 M8 判别联合式全仓消费面改造重演。
 * `resetOn` 只是给 Host 的标签，服务端不做任何自动重置（看板红线）。
 */
export const RESOURCE_RESET_ON = ['short_rest', 'long_rest', 'none'] as const;
export type ResourceResetOn = (typeof RESOURCE_RESET_ON)[number];

export const ResourceSchema = z.object({
  /** 资源名，如「一环法术位」「箭矢」 */
  name: z.string(),
  current: z.number(),
  max: z.number(),
  resetOn: z.enum(RESOURCE_RESET_ON).default('none'),
});
export type Resource = z.infer<typeof ResourceSchema>;

export const StateBoardPcSchema = z.object({
  sheet: PCSheetSchema,
  /** 如 [{ label: "疯狂(临时)", note: "见血即触发" }] */
  conditions: z.array(ConditionSchema),
  /** 缺省空数组：v2.0 存档无此字段，加字段带默认即向后兼容 */
  resources: z.array(ResourceSchema).default([]),
});
export type StateBoardPc = z.infer<typeof StateBoardPcSchema>;

/**
 * 先攻条目（v3 FR-37）：ref 是状态板内的定位键——PC 用 memberId，NPC 用 `npc:<名字>`。
 * roll 是先攻值（由玩家掷骰产生、Host 录入或确认），看板只做排序与展示。
 */
export const InitiativeEntrySchema = z.object({
  ref: z.string(),
  label: z.string(),
  roll: z.number(),
});
export type InitiativeEntry = z.infer<typeof InitiativeEntrySchema>;

/**
 * 先攻看板（ADR-3-06：状态板 scene 扩展，复用 state:update / state:broadcast 既有通道）。
 * 红线：只做数据与展示——currentIdx / round 的推进一律由 Host 手动点，
 * 服务端与前端都不含任何「自动结算/自动推进」代码路径。
 */
export const InitiativeSchema = z.object({
  /** 按先攻值降序保存；展示即此顺序 */
  order: z.array(InitiativeEntrySchema),
  /** 当前行动者在 order 中的下标 */
  currentIdx: z.number().int(),
  /** 轮次，从 1 起 */
  round: z.number().int().nonnegative(),
});
export type Initiative = z.infer<typeof InitiativeSchema>;

export const StateBoardSceneSchema = z.object({
  name: z.string(),
  time: z.string(),
  publicDesc: z.string(),
  /** 缺省 = 本场景无先攻（v2.0 行为）；null = Host 显式清除 */
  initiative: InitiativeSchema.nullable().optional(),
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

/**
 * ccv3 卡（M5/T-M5-01 细化）。
 *
 * 两个刻意的选择（FR-08「直接兼容社区存量资产」）：
 * 1. `spec_version` 显式保留——ccv3 规范字段，strip 掉会让导出回社区的卡残缺；
 * 2. `data` 用 looseObject——社区卡的 personality / creator_notes / tags / alternate_greetings
 *    等标准字段我们不消费，但导出时必须原样带回，否则「导入→导出」是有损的。
 *    我们依赖的那几个字段仍然严格校验（TC-FR-08-001）。
 */
export const CharacterCardV3Schema = z.object({
  spec: z.literal('chara_card_v3'),
  spec_version: z.string().optional(),
  data: z.looseObject({
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
