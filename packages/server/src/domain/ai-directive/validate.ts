import type { CheckDirective } from './schema.js';
import { CheckDirectiveSchema } from './schema.js';

export type DirectiveValidation =
  { ok: true; directive: CheckDirective } | { ok: false; code: 'E-AI-01'; reason: string };

/**
 * op 白名单校验（T-M3-02，TDD §5.4：v1 仅 `check`，二期扩展 roll/emote/set_fact）。
 *
 * 三类拒绝都归 E-AI-01（TDD §11：KP 端告警、玩家无感、计入 R-01 指标）：
 * 非对象 / 未知 op（白名单拒绝）/ 字段校验失败（未知字段、非法 target 等，strictObject）。
 * 拒绝不掷骰——执行器只消费 ok 分支。
 */
export function validateDirective(parsed: unknown): DirectiveValidation {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, code: 'E-AI-01', reason: '指令块必须是 JSON 对象' };
  }

  const op = (parsed as { op?: unknown }).op;
  if (op !== 'check') {
    return { ok: false, code: 'E-AI-01', reason: `未知 op: ${String(op)}（v1 白名单仅 check）` };
  }

  const result = CheckDirectiveSchema.safeParse(parsed);
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
