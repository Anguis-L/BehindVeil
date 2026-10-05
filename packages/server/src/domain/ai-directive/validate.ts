import type { AiDirective } from './schema.js';
import {
  CheckDirectiveSchema,
  DamageDirectiveSchema,
  HealDirectiveSchema,
  ResourceDirectiveSchema,
  SanityDirectiveSchema,
} from './schema.js';
import { z } from 'zod';

export type DirectiveValidation =
  { ok: true; directive: AiDirective } | { ok: false; code: 'E-AI-01'; reason: string };

/** op → Schema 白名单（T-M8-03/04 扩值：check / damage / heal / sanity；T-M12-02 加 resource） */
const OP_SCHEMAS: Record<string, z.ZodType<AiDirective>> = {
  check: CheckDirectiveSchema,
  damage: DamageDirectiveSchema,
  heal: HealDirectiveSchema,
  sanity: SanityDirectiveSchema,
  resource: ResourceDirectiveSchema,
};

/** 白名单的人类可读串（E-AI-01 提示文案，与 OP_SCHEMAS 同源派生，防两处漂移） */
const OP_WHITELIST_TEXT = Object.keys(OP_SCHEMAS).join(' / ');

/**
 * op 白名单校验（T-M3-02 / T-M8-03，TDD §5.4 + 设计文档 v2 §5.4）。
 *
 * 三类拒绝都归 E-AI-01（TDD §11：KP 端告警、玩家无感、计入 R-01 指标）：
 * 非对象 / 未知 op（白名单拒绝）/ 字段校验失败（未知字段、非法 target、夹带
 * result/total/hp 等数值字段，strictObject 一律拒）。
 * 拒绝不掷骰——执行器只消费 ok 分支。
 */
export function validateDirective(parsed: unknown): DirectiveValidation {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, code: 'E-AI-01', reason: '指令块必须是 JSON 对象' };
  }

  const op = (parsed as { op?: unknown }).op;
  const schema = typeof op === 'string' ? OP_SCHEMAS[op] : undefined;
  if (!schema) {
    return {
      ok: false,
      code: 'E-AI-01',
      reason: `未知 op: ${String(op)}（白名单：${OP_WHITELIST_TEXT}）`,
    };
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    // Zod 契约：失败时 issues 非空
    const issue = result.error.issues[0]!;
    const path = issue.path.join('.');
    return {
      ok: false,
      code: 'E-AI-01',
      reason: `字段校验失败：${path ? `${path}: ` : ''}${issue.message}`,
    };
  }

  return { ok: true, directive: result.data };
}
