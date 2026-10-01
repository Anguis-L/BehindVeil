import type { StateBoard, StatePatch } from '@behindveil/shared';
import type { ParsedRoll } from '../dice/evaluator.js';
import type { RuleBook } from '../rulebook/types.js';

/**
 * 引擎写路径（T-M5-08 / T-M8-03/04，FR-05/09/25/27）：规则效果 → 状态板 patch。
 * 「规则效果闭环写状态板」的落位：数值由规则引擎按服务端掷骰产生，LLM 全程不介入
 * （CODING_STANDARDS §2.2 服务端权威）。
 *
 * 刻意保持纯函数：骰由调用方掷好传入（ParsedRoll 带原始骰值，与消息链路共用
 * 审计留痕；本模块不掷骰、不做 IO）。指令 op 由 loop 侧装配后经 applyStatePatch
 * （board.ts）走与 Host 相同的乐观锁写路径落盘广播（TC-FR-09-003「引擎路径可写」）。
 * 规则书不匹配（如 COC 卡收到 damage/heal、5e 卡收到 sanity）返回 rulebook-mismatch，
 * 由调用方归 E-AI-01 拒绝（设计 §5.4 防呆）。
 */

export type SanityPatchResult =
  | { ok: true; patch: StatePatch; loss: number; lossExpr: string; desc: string }
  | {
      ok: false;
      reason: 'pc-not-found' | 'sanity-rule-missing' | 'rulebook-mismatch';
    };

/**
 * 理智扣除 → state patch（FR-27）：SAN 检定骰值（d100 原始值）交规则书 sanityRule
 * 查损失表达式（损失数值以 lossRoll 为准——调用方对该表达式掷出的服务端骰）。
 * SAN 最低扣到 0（COC7：理智归零即永久疯狂，状态标注留规则书后续细化）。
 * 仅 COC7 卡有 san 字段；5e 卡 → rulebook-mismatch。
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
  if (pc.sheet.rulebook !== 'coc7') return { ok: false, reason: 'rulebook-mismatch' };
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

export type HpPatchResult =
  | { ok: true; patch: StatePatch; applied: number }
  | { ok: false; reason: 'pc-not-found' | 'rulebook-mismatch' };

/**
 * 伤害/治疗 → state patch（FR-25）：amountRoll 为调用方对指令 expr 掷出的服务端骰，
 * `hp.current = clamp(current ∓ total, 0, hp.max)`（下限 0、上限 max；applied 为
 * clamp 后实际变动量，供回注文案区分「溢出治疗/过量伤害」）。
 * 仅 5e 卡有 hp.max/current 结构；COC 卡 → rulebook-mismatch。
 */
export function hpPatch(
  board: StateBoard,
  target: string,
  kind: 'damage' | 'heal',
  amountRoll: ParsedRoll,
): HpPatchResult {
  const pc = board.pcs[target];
  if (!pc) return { ok: false, reason: 'pc-not-found' };
  if (pc.sheet.rulebook !== 'dnd5e') return { ok: false, reason: 'rulebook-mismatch' };

  const { max, current } = pc.sheet.hp;
  const delta = kind === 'damage' ? -amountRoll.total : amountRoll.total;
  const next = Math.min(Math.max(current + delta, 0), max);
  return {
    ok: true,
    applied: Math.abs(next - current),
    patch: {
      pcs: {
        [target]: {
          sheet: { ...pc.sheet, hp: { ...pc.sheet.hp, current: next } },
          conditions: pc.conditions,
        },
      },
    },
  };
}
