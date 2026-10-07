import { z } from 'zod';
import { RULEBOOK_IDS } from './dice.js';
import { StateBoardSceneSchema } from './domain.js';

/**
 * 模组包契约（T-M5-05，FR-10 / TDD §3.6）。
 *
 * data/modules/<module-id>/ 下 manifest.json + 三件套（kp-card / worldbook / init-state），
 * 目录名 = manifest.id（加载时强校验一致）。manifest.apiVersion 与服务端
 * MODULE_API_VERSION 不符即拒载（TC-FR-10-001）；卸载策略 D-09（活跃引用拒绝）
 * 由服务端域层执行。openapi 的 ModuleInfo 与 ModuleInfoSchema 对齐。
 */

/** 模组适配的服务端 API 版本；随协议演进 bumps，旧模组拒载并提示 */
export const MODULE_API_VERSION = '1';

export const ModuleManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  rulebook: z.enum(RULEBOOK_IDS),
  apiVersion: z.literal(MODULE_API_VERSION),
  /** 三件套文件名（相对模组目录），默认约定 kp-card.json / worldbook.json / init-state.json */
  entry: z.object({
    kpCard: z.string().min(1),
    worldBook: z.string().min(1),
    initState: z.string().min(1),
  }),
});
export type ModuleManifest = z.infer<typeof ModuleManifestSchema>;

/** init-state.json：状态板初始值（scene/facts，开团时合入 state.json）+ 开场引导 */
export const InitStateSchema = z.object({
  scene: StateBoardSceneSchema,
  facts: z.array(z.string()).default([]),
  /** KP 开场引导素材；开场白生成本身由叙事链路承载（v1 不做自动开场钩子） */
  opening: z.string().default(''),
});
export type InitState = z.infer<typeof InitStateSchema>;

/** REST /modules 列表/装载响应（docs/openapi.yaml ModuleInfo） */
export const ModuleInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  rulebook: z.enum(RULEBOOK_IDS),
  apiVersion: z.string(),
  /** 引用该模组的活跃会话数（D-09 卸载判据的可视化） */
  activeSessions: z.number().int().nonnegative(),
});
export type ModuleInfo = z.infer<typeof ModuleInfoSchema>;
