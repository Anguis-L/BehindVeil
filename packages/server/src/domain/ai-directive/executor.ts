import type { CheckOp, DiceKind, StateBoard } from '@behindveil/shared';
import type { ParsedRoll } from '../dice/evaluator.js';
import { rollDice } from '../dice/evaluator.js';
import { createCsprngRandom, type RandomSource } from '../dice/random.js';
import { DiceExpressionError, parseDiceExpr } from '../dice/parser.js';
import { DND5E_DEFAULT_DC, createRuleBook } from '../rulebook/index.js';
import type { RuleBook } from '../rulebook/types.js';
import { resolvePc } from '../stateboard/roster.js';
import type {
  CheckDirective,
  DamageDirective,
  HealDirective,
  ResourceDirective,
  SanityDirective,
} from './schema.js';

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
  // 骰式随规则书分流（v2 FR-24 / v3 FR-40）：COC7 是「d100 与技能值比小」，
  // 5e 是「d20+修正 够不够 DC」，generic 按 KP 配置的骰型与方向。三种情况的数值
  // 都来自名册（5e/generic 的修正值由服务端从卡面现取），AI 一律不传数值。
  let expr: string;
  let kind: DiceKind;
  if (rulebook.id === 'generic') {
    const config = rulebook.genericConfig;
    // 工厂契约：id='generic' 必带配置（createRuleBook 已把关），断言仅供类型收窄
    if (!config) throw new RangeError('generic 规则书缺少 genericRule 配置');
    if (directive.dc === undefined) {
      return {
        ok: false,
        code: 'E-AI-01',
        reason: 'generic 规则书检定必须带 dc（自定义判定表无官方缺省目标值，KP 未给）',
      };
    }
    expr = modCheckExpr(config.dice, lookup.value, config.op, directive.dc);
    kind =
      directive.kind && config.kinds.includes(directive.kind)
        ? directive.kind
        : (config.kinds[0] ?? 'check');
  } else if (rulebook.id === 'dnd5e') {
    expr = d20CheckExpr(lookup.value, directive.dc ?? DND5E_DEFAULT_DC[directive.difficulty]);
    kind = directive.kind ?? 'ability';
  } else {
    expr = `1d100<=${lookup.value}`;
    kind = 'skill';
  }

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

/** generic 检定骰式：`<主骰>+修正<op>目标`；修正口径与 d20CheckExpr 相同 */
function modCheckExpr(dice: string, modifier: number, op: CheckOp, target: number): string {
  const mod = modifier === 0 ? '' : modifier > 0 ? `+${modifier}` : `${modifier}`;
  return `${dice}${mod}${op}${target}`;
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
      /** 目标在状态板内的键（引擎写板按此定位） */
      key: string;
      /** 服务端掷出的效果骰（无判定后缀 → check=null，与检定骰同一审计通道） */
      roll: ParsedRoll;
    }
  | { ok: false; code: 'E-AI-01'; reason: string };

/**
 * 伤害/治疗执行器（FR-25）：AI 只传表达式与目标，面值由服务端 CSPRNG 掷出；
 * HP 写入由网关在房间队列内对**当前板**现算 clamp（同一轮多条效果指令依次累加，
 * 不吃前条效果落盘前的过期快照）。此处只做防呆校验 + 掷骰：COC 卡（无 hp.max/current
 * 结构）在掷骰前即拒（E-AI-01 防呆，设计 §5.4 第 5 步），不产生任何骰值。
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
  return { ok: true, pcName: sheet.playerName, key: resolved.key, roll };
}

export type SanityExecution =
  | {
      ok: true;
      pcName: string;
      /** 目标在状态板内的键 */
      key: string;
      /** SAN 检定骰（1d100<=san，判定交规则书） */
      checkRoll: ParsedRoll;
    }
  | { ok: false; code: 'E-AI-01'; reason: string };

/**
 * 理智检定执行器（FR-27，v1 欠账 b 的接线）：掷 SAN 检定（判定交规则书）。
 * 损失表档位与 SAN 扣减在网关队列内对**当前板**现算（sanityRule 的档位以当前 SAN
 * 为判定目标——同一轮多次理智检定必须逐条基于最新值）；KP 显式 loss 表达式随端口
 * 透传，仍由服务端掷骰。仅 COC7 卡 + 有 sanityRule 能力的规则书，掷骰前即拒
 * （E-AI-01 防呆）。
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
  return { ok: true, pcName: sheet.playerName, key: resolved.key, checkRoll };
}

export type ResourceExecution =
  | {
      ok: true;
      pcName: string;
      /** 目标在状态板内的键 */
      key: string;
      /** 命中的资源名（回注文案用；与指令同名，大小写与空白均已 trim） */
      name: string;
      delta: number;
    }
  | { ok: false; code: 'E-AI-01'; reason: string };

/**
 * 资源计数器执行器（T-M12-02，FR-38）：**不掷骰**——法术位/箭矢的消耗是确定的「几个」，
 * 没有随机结构（区别于 damage/heal 的表达式）。此处只做防呆：PC 存在、资源名存在、
 * 且资源确实有可变动空间（已满还让恢复 / 已空还让消耗 = AI 表达自相矛盾，归 E-AI-01
 * 并由 KP 告警，不静默 clamp 成零变动）。实际 clamp 落板在网关队列内的 resourcePatch。
 */
export function executeResource(
  directive: ResourceDirective,
  deps: EffectExecutorDeps,
): ResourceExecution {
  const board = deps.board;
  const resolved = board ? resolvePc(board, directive.target.slice('pc:'.length)) : null;
  if (!board || !resolved) {
    return { ok: false, code: 'E-AI-01', reason: `名册查无 PC：${directive.target}` };
  }
  const resource = resolved.pc.resources.find((r) => r.name === directive.name);
  if (!resource) {
    return {
      ok: false,
      code: 'E-AI-01',
      reason: `${resolved.pc.sheet.playerName} 没有名为「${directive.name}」的资源计数器`,
    };
  }
  if (directive.delta === 0) {
    return { ok: false, code: 'E-AI-01', reason: `资源变动量为 0，指令无意义：${directive.name}` };
  }
  const target = resource.current + directive.delta;
  if (target < 0) {
    return {
      ok: false,
      code: 'E-AI-01',
      reason: `「${directive.name}」余量不足（当前 ${resource.current}，需消耗 ${Math.abs(directive.delta)}）`,
    };
  }
  if (target > resource.max) {
    return {
      ok: false,
      code: 'E-AI-01',
      reason: `「${directive.name}」恢复量超过上限（当前 ${resource.current}，上限 ${resource.max}）`,
    };
  }
  return {
    ok: true,
    pcName: resolved.pc.sheet.playerName,
    key: resolved.key,
    name: directive.name,
    delta: directive.delta,
  };
}
