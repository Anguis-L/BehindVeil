import type { StateBoard, StateBoardPc } from '@behindveil/shared';
import type { PcRoster, RosterLookup } from '../ai-directive/executor.js';
import { dnd5eSkillModifier } from '../rulebook/dnd5e.js';

/**
 * PC 名册（T-M5-04）：`PcRoster` 端口（T-M3-03）的真实实现，替换 T-M3-03a 内存 stub。
 *
 * 数值权威源 = 状态板（SDD §3.7：任何数值以状态板为准）——检定取值不再读硬编码样例，
 * 而是读活跃会话的状态板快照。板由网关内存态持有（写路径同步维护），故本实现保持
 * 端口的同步签名，不做 IO。
 *
 * target 解析（语义归名册，executor 注释）：`pc:` 后先按 memberId 精确命中，
 * 再回退 PC 名（playerName）——AI 指令块里可读的标识是叙事中的名字（memberId 是
 * nanoid），memberId 形式留给程序化调用。
 *
 * 取值按卡的类型分流（v2 FR-24）：COC7 查 `skills[技能名]`；5e **现算**修正值
 * `floor((属性−10)/2) + (熟练 ? 熟练加值 : 0)`——修正值永远由服务端算，
 * AI 与客户端都不传数值。
 */
export function createStateBoardRoster(board: StateBoard | undefined): PcRoster {
  return {
    skillValue(target: string, skill: string): RosterLookup {
      if (!target.startsWith('pc:')) return { found: false, reason: 'pc-not-found' };
      const key = target.slice('pc:'.length);
      const pc = findPc(board, key);
      if (!pc) return { found: false, reason: 'pc-not-found' };
      const sheet = pc.pc.sheet;

      if (sheet.rulebook === 'dnd5e') {
        const modifier = dnd5eSkillModifier(sheet, skill);
        if (modifier === null) return { found: false, reason: 'skill-not-found' };
        return { found: true, value: modifier, name: sheet.playerName };
      }

      const value = sheet.skills[skill];
      if (value === undefined) return { found: false, reason: 'skill-not-found' };
      return { found: true, value, name: sheet.playerName };
    },
  };
}

function findPc(board: StateBoard | undefined, key: string) {
  return resolvePc(board, key);
}

/**
 * target 解析的唯一实现：`pc:` 后的标识先按 memberId 精确命中，再回退 PC 名。
 * 返回板内键（memberId）——引擎写路径（damage/heal/sanity patch）需要按键定位。
 */
export function resolvePc(
  board: StateBoard | undefined,
  key: string,
): { key: string; pc: StateBoardPc } | undefined {
  if (!board) return undefined;
  const byId = board.pcs[key];
  if (byId) return { key, pc: byId };
  for (const [k, pc] of Object.entries(board.pcs)) {
    if (pc.sheet.playerName === key) return { key: k, pc };
  }
  return undefined;
}
