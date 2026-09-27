import type { StateBoard, StatePatch } from '@behindveil/shared';
import type { ParsedRoll } from '../dice/evaluator.js';
import type { RuleBook } from '../rulebook/types.js';

/**
 * 引擎写路径示例（T-M5-08，FR-05/09）：COC7 理智检定 → sanityRule 损失 → 状态板 patch。
 * 「规则效果闭环写状态板」的落位：损失数值由规则引擎按服务端掷骰产生，LLM 全程不介入
 * （CODING_STANDARDS §2.2 服务端权威）。
 *
 * 刻意保持纯函数：损失骰由调用方掷好传入（ParsedRoll 带原始骰值，与消息链路共用
 * 审计留痕；本模块不掷骰、不做 IO）。sanity 指令 op 接入协议时由 loop 侧装配。
 * 产出的 patch 经 applyStatePatch（board.ts）走与 Host 相同的乐观锁写路径落盘广播
 * （TC-FR-09-003「引擎路径可写」）。
 */

export type SanityPatchResult =
  | { ok: true; patch: StatePatch; loss: number; lossExpr: string; desc: string }
  | { ok: false; reason: 'pc-not-found' | 'sanity-rule-missing' };

/**
 * 理智扣除 → state patch：SAN 检定骰值（d100 原始值）交规则书 sanityRule 查损失
 * 表达式（损失数值以 lossRoll 为准——调用方对该表达式掷出的服务端骰）。
 * SAN 最低扣到 0（COC7：理智归零即永久疯狂，状态标注留规则书后续细化）。
 */
export function sanityLossPatch(
  board: StateBoard,
  target: string,
  sanRoll: number,
  lossRoll: ParsedRoll,
  rulebook: RuleBook,
): SanityPatchResult {
  const pc = board.pcs[target];
  if (!pc) return { ok: false, reason: 'pc-not-found' };
  if (!rulebook.sanityRule) return { ok: false, reason: 'sanity-rule-missing' };

  const { loss, desc } = rulebook.sanityRule(sanRoll, pc.sheet.san);
  const applied = Math.min(lossRoll.total, pc.sheet.san);
  return {
    ok: true,
    loss: applied,
    lossExpr: loss,
    desc,
    patch: {
      pcs: {
        [target]: {
          sheet: { ...pc.sheet, san: pc.sheet.san - applied },
          conditions: pc.conditions,
        },
      },
    },
  };
}
