import type { PcRoster } from '../ai-directive/executor.js';

/**
 * PC 名册内存 stub（T-M3-03a，TDD §5.4 检定执行器的过渡取值源）。
 *
 * @temp T-M3-03a —— **M5 时由 T-M5-04 真实名册替换**（导入卡 → pcSheet 进状态板初始，
 * SDD §5.1 开团流程）。硬编码样例 PC 仅覆盖技能检定取值路径；
 * 技能表精确匹配，缺省技能值/专业 modifier 等规则随真实名册落地。
 * 样例名即 `pc:` 目标标识（alice / bob）。
 */

export interface StubPc {
  name: string;
  skills: Record<string, number>;
}

const SAMPLE_PCS: Record<string, StubPc> = {
  alice: { name: '爱丽丝', skills: { 侦查: 60, 图书馆使用: 50, 聆听: 45 } },
  bob: { name: '鲍勃', skills: { 聆听: 55, 急救: 50, 攀爬: 65 } },
};

export function createRosterStub(): PcRoster {
  return {
    skillValue(target: string, skill: string) {
      if (!target.startsWith('pc:')) return { found: false, reason: 'pc-not-found' } as const;
      const pc = SAMPLE_PCS[target.slice('pc:'.length)];
      if (!pc) return { found: false, reason: 'pc-not-found' } as const;
      const value = pc.skills[skill];
      if (value === undefined) return { found: false, reason: 'skill-not-found' } as const;
      return { found: true, value, name: pc.name } as const;
    },
  };
}
