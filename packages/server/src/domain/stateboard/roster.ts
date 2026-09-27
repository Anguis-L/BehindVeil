import type { StateBoard } from '@behindveil/shared';
import type { PcRoster, RosterLookup } from '../ai-directive/executor.js';

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
 */
export function createStateBoardRoster(board: StateBoard | undefined): PcRoster {
  return {
    skillValue(target: string, skill: string): RosterLookup {
      if (!target.startsWith('pc:')) return { found: false, reason: 'pc-not-found' };
      const key = target.slice('pc:'.length);
      const pc = findPc(board, key);
      if (!pc) return { found: false, reason: 'pc-not-found' };
      const value = pc.sheet.skills[skill];
      if (value === undefined) return { found: false, reason: 'skill-not-found' };
      return { found: true, value, name: pc.sheet.playerName };
    },
  };
}

function findPc(board: StateBoard | undefined, key: string) {
  if (!board) return undefined;
  const byId = board.pcs[key];
  if (byId) return byId;
  for (const pc of Object.values(board.pcs)) {
    if (pc.sheet.playerName === key) return pc;
  }
  return undefined;
}
