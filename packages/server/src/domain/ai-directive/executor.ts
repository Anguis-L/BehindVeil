import type { ParsedRoll } from '../dice/evaluator.js';
import { rollDice } from '../dice/evaluator.js';
import { createCsprngRandom, type RandomSource } from '../dice/random.js';
import { Coc7RuleBook } from '../rulebook/coc7.js';
import type { RuleBook } from '../rulebook/types.js';
import type { CheckDirective } from './schema.js';

/** 名册查询产物：found=false 区分查无人/查无技能（KP 告警文案需要） */
export type RosterLookup =
  | { found: true; value: number; name: string }
  | { found: false; reason: 'pc-not-found' | 'skill-not-found' };

/**
 * PC 名册端口（T-M3-03）。
 * v1 由 `stateboard/roster.stub.ts` 提供内存实现（@temp T-M3-03a），
 * M5 T-M5-04 真实名册落地后按本端口结构化替换。
 */
export interface PcRoster {
  /** target 为指令块原样的 `pc:<标识>` 串；标识语义归名册解析 */
  skillValue(target: string, skill: string): RosterLookup;
}

export interface CheckExecutorDeps {
  roster: PcRoster;
  rulebook?: RuleBook;
  random?: RandomSource;
}

export type CheckExecution =
  | {
      ok: true;
      /** 服务端一站式掷骰产物：expr 为 `1d100<=技能值`，check 含 outcome/grade（audit 由 T-M4-01 补） */
      roll: ParsedRoll;
      /** PC 展示名与技能值（SystemMsg 回注文案 / DiceMsg 卡片用） */
      pcName: string;
      skillValue: number;
    }
  | { ok: false; code: 'E-AI-01'; reason: string };

/** COC7 无状态，模块级单例避免每次检定重建 */
const DEFAULT_RULEBOOK = new Coc7RuleBook();

/**
 * 检定执行器（T-M3-03，TDD §5.4）。
 *
 * AI 只传技能名与目标 PC（CheckDirective，Schema 层已拒一切数值字段）——
 * 技能值在此从名册取出，骰式由服务端拼成 `1d100<=技能值` 交 P 轨道引擎掷骰判定。
 * 数值全程不出自 LLM（CODING_STANDARDS §2.2 服务端权威，TC-FR-05-008 防篡改）。
 * 名册查无 PC / 无此技能属 AI 产出无效指令，归 E-AI-01，由调用方计入 R-01。
 */
export function executeCheck(directive: CheckDirective, deps: CheckExecutorDeps): CheckExecution {
  const lookup = deps.roster.skillValue(directive.target, directive.skill);
  if (!lookup.found) {
    return {
      ok: false,
      code: 'E-AI-01',
      reason:
        lookup.reason === 'pc-not-found'
          ? `名册查无 PC：${directive.target}`
          : `PC ${directive.target} 无技能：${directive.skill}`,
    };
  }

  const roll = rollDice(`1d100<=${lookup.value}`, {
    random: deps.random ?? createCsprngRandom(),
    rulebook: deps.rulebook ?? DEFAULT_RULEBOOK,
    kind: 'skill',
    difficulty: directive.difficulty,
  });
  return { ok: true, roll, pcName: lookup.name, skillValue: lookup.value };
}
