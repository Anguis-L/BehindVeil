import type { Message } from '@behindveil/shared';

/**
 * 骰子卡的判定展示（T-M7-05，v2 FR-21/22）。
 *
 * 与 kp-console.ts 同思路：抽成纯函数便于单测，组件只负责渲染。
 * 数值一律来自服务端判定记录（check），前端不产生任何判定。
 */

/** 判定种类中文名：COC 四种 + 5e 四种；映射表外的种类（generic 自定义）按原值直显（v3 FR-40） */
const DICE_KIND_LABELS: Record<string, string> = {
  skill: '技能检定',
  sanity: '理智检定',
  opposed: '对抗检定',
  luck: '幸运检定',
  ability: '属性检定',
  save: '豁免检定',
  attack: '攻击检定',
  initiative: '先攻',
};

/** 判定种类名；映射表外按原值直显，无判定记录（纯骰值，如先攻）时为 null */
export function diceKindLabel(msg: Message): string | null {
  if (msg.type !== 'dice') return null;
  const check = msg.roll.check;
  if (!check) return null;
  return DICE_KIND_LABELS[check.kind] ?? check.kind;
}

/**
 * 判定目标值：5e 攻击写 AC、其余写 DC。
 * COC 的目标值已经写在骰式里（`1d100<=60`），不再重复展示。
 */
export function diceTargetLabel(msg: Message): string | null {
  if (msg.type !== 'dice') return null;
  const check = msg.roll.check;
  if (!check || check.op !== '>=') return null;
  return `${check.kind === 'attack' ? 'AC' : 'DC'} ${check.target}`;
}

/** nat20 / nat1 徽章：仅 5e——判的是 d20 面值；COC 的大成功是骰值 1，不能叫 nat20 */
export function diceNatBadge(msg: Message): string | null {
  if (msg.type !== 'dice' || msg.hidden) return null;
  const check = msg.roll.check;
  if (!check || check.rulebook !== 'dnd5e') return null;
  if (check.outcome === 'critical') return 'NAT 20';
  if (check.outcome === 'fumble') return 'NAT 1';
  return null;
}
