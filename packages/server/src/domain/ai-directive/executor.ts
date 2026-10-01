import type { StateBoard, StatePatch } from '@behindveil/shared';
import type { ParsedRoll } from '../dice/evaluator.js';
import { rollDice } from '../dice/evaluator.js';
import { createCsprngRandom, type RandomSource } from '../dice/random.js';
import { DiceExpressionError, parseDiceExpr } from '../dice/parser.js';
import { DND5E_DEFAULT_DC, createRuleBook } from '../rulebook/index.js';
import type { RuleBook } from '../rulebook/types.js';
import { hpPatch, sanityLossPatch } from '../stateboard/engine-writes.js';
import { resolvePc } from '../stateboard/roster.js';
import type { CheckDirective, DamageDirective, HealDirective, SanityDirective } from './schema.js';

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

/** 未装配规则书时（单测/裸调）按 COC7 判定；规则书无状态，模块级复用避免每次重建 */
const DEFAULT_RULEBOOK = createRuleBook('coc7');

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

  const rulebook = deps.rulebook ?? DEFAULT_RULEBOOK;
  // 骰式随规则书分流（v2 FR-24）：COC7 是「d100 与技能值比小」，5e 是「d20+修正 够不够 DC」。
  // 两种情况的数值都来自名册（5e 的修正值由服务端现算），AI 一律不传数值。
  const expr =
    rulebook.id === 'dnd5e'
      ? d20CheckExpr(lookup.value, directive.dc ?? DND5E_DEFAULT_DC[directive.difficulty])
      : `1d100<=${lookup.value}`;
  const kind = rulebook.id === 'dnd5e' ? (directive.kind ?? 'ability') : 'skill';

  const roll = rollDice(expr, {
    random: deps.random ?? createCsprngRandom(),
    rulebook,
    kind,
    difficulty: directive.difficulty,
  });
  return { ok: true, roll, pcName: lookup.name, skillValue: lookup.value };
}

/** 5e 检定骰式：`1d20+修正>=DC`；修正为零省略、为负改减号（骰式文法无 `+-`） */
function d20CheckExpr(modifier: number, dc: number): string {
  if (modifier === 0) return `1d20>=${dc}`;
  return modifier > 0 ? `1d20+${modifier}>=${dc}` : `1d20${modifier}>=${dc}`;
}

// ---- 数值效果执行器（T-M8-03/04，FR-25/27，设计 §5.4）----

export interface EffectExecutorDeps {
  /** 目标 PC 所在状态板（数值权威源）；缺省视为未载入 */
  board?: StateBoard;
  rulebook?: RuleBook;
  random?: RandomSource;
}

export type HpExecution =
  | {
      ok: true;
      pcName: string;
      /** 服务端掷出的效果骰（无判定后缀 → check=null，与检定骰同一审计通道） */
      roll: ParsedRoll;
      /** 引擎写路径产物（clamp 0..max），调用方经乐观锁端口落盘广播 */
      patch: StatePatch;
      before: number;
      after: number;
    }
  | { ok: false; code: 'E-AI-01'; reason: string };

/**
 * 伤害/治疗执行器（FR-25）：AI 只传表达式与目标，面值由服务端 CSPRNG 掷出；
 * HP 由引擎写路径 clamp 到 [0, max]。COC 卡（无 hp.max/current 结构）在掷骰前即拒
 * （E-AI-01 防呆，设计 §5.4 第 5 步），不产生任何骰值。
 */
export function executeHp(
  directive: DamageDirective | HealDirective,
  deps: EffectExecutorDeps,
): HpExecution {
  const board = deps.board;
  const resolved = resolvePc(board, directive.target.slice('pc:'.length));
  if (!board || !resolved) {
    return { ok: false, code: 'E-AI-01', reason: `名册查无 PC：${directive.target}` };
  }
  const sheet = resolved.pc.sheet;
  if (sheet.rulebook !== 'dnd5e') {
    return {
      ok: false,
      code: 'E-AI-01',
      reason: `${sheet.playerName} 的角色卡不是 5e 卡，伤害/治疗仅对 5e 卡生效`,
    };
  }

  const rulebook = deps.rulebook ?? DEFAULT_RULEBOOK;
  let roll: ParsedRoll;
  try {
    const parsed = parseDiceExpr(directive.expr);
    if (parsed.check) {
      return {
        ok: false,
        code: 'E-AI-01',
        reason: `伤害/治疗表达式不应带判定后缀：${directive.expr}`,
      };
    }
    roll = rollDice(directive.expr, { random: deps.random ?? createCsprngRandom(), rulebook });
  } catch (err) {
    if (err instanceof DiceExpressionError) {
      return { ok: false, code: 'E-AI-01', reason: `无效的伤害/治疗表达式：${directive.expr}` };
    }
    throw err;
  }

  const result = hpPatch(board, resolved.key, directive.op, roll);
  if (!result.ok) {
    return {
      ok: false,
      code: 'E-AI-01',
      reason:
        result.reason === 'rulebook-mismatch'
          ? `${sheet.playerName} 的角色卡不支持 HP 写入`
          : `名册查无 PC：${directive.target}`,
    };
  }
  const after =
    directive.op === 'damage'
      ? sheet.hp.current - result.applied
      : sheet.hp.current + result.applied;
  return {
    ok: true,
    pcName: sheet.playerName,
    roll,
    patch: result.patch,
    before: sheet.hp.current,
    after,
  };
}

export type SanityExecution =
  | {
      ok: true;
      pcName: string;
      /** SAN 检定骰（1d100<=san，判定交规则书） */
      checkRoll: ParsedRoll;
      /** 损失骰（房规损失表表达式或 KP 指定表达式，服务端掷） */
      lossRoll: ParsedRoll;
      patch: StatePatch;
      before: number;
      after: number;
      /** 检定档位描述（房规表 desc）；KP 显式指定损失时为「KP 指定损失 …」 */
      desc: string;
    }
  | { ok: false; code: 'E-AI-01'; reason: string };

/**
 * 理智检定执行器（FR-27，v1 欠账 b 的接线）：先掷 SAN 检定（判定交规则书），
 * 再按房规损失表（或 KP 显式表达式）掷损失骰，引擎写路径扣 SAN（clamp 0）。
 * 仅 COC7 卡 + 有 sanityRule 能力的规则书；其余组合掷骰前即拒（E-AI-01 防呆）。
 */
export function executeSanity(
  directive: SanityDirective,
  deps: EffectExecutorDeps,
): SanityExecution {
  const board = deps.board;
  const resolved = resolvePc(board, directive.target.slice('pc:'.length));
  if (!board || !resolved) {
    return { ok: false, code: 'E-AI-01', reason: `名册查无 PC：${directive.target}` };
  }
  const sheet = resolved.pc.sheet;
  if (sheet.rulebook !== 'coc7') {
    return {
      ok: false,
      code: 'E-AI-01',
      reason: `${sheet.playerName} 的角色卡不是 COC7 卡，理智检定仅对 COC7 卡生效`,
    };
  }
  const rulebook = deps.rulebook ?? DEFAULT_RULEBOOK;
  if (!rulebook.sanityRule) {
    return { ok: false, code: 'E-AI-01', reason: '规则书不支持理智检定（无 sanityRule）' };
  }

  const random = deps.random ?? createCsprngRandom();
  const checkRoll = rollDice(`1d100<=${sheet.san}`, { random, rulebook, kind: 'sanity' });
  const table = rulebook.sanityRule(checkRoll.total, sheet.san);
  const lossExpr = directive.loss ?? table.loss;
  const lossRoll = rollDice(lossExpr, { random, rulebook });

  const patched = sanityLossPatch(board, resolved.key, checkRoll.total, lossRoll, rulebook);
  if (!patched.ok) {
    return {
      ok: false,
      code: 'E-AI-01',
      reason:
        patched.reason === 'sanity-rule-missing'
          ? '规则书不支持理智检定（无 sanityRule）'
          : `名册查无 PC：${directive.target}`,
    };
  }
  return {
    ok: true,
    pcName: sheet.playerName,
    checkRoll,
    lossRoll,
    patch: patched.patch,
    before: sheet.san,
    after: sheet.san - patched.loss,
    desc: directive.loss ? `KP 指定损失 ${lossExpr}` : table.desc,
  };
}
