import type { ErrorCode, RollCheck, StateBoard } from '@behindveil/shared';
import type { ParsedRoll } from '../dice/evaluator.js';
// 缺省 CSPRNG 由 executeCheck 兜底（executor.ts），本层只透传测试注入的确定性源
import type { RandomSource } from '../dice/random.js';
import type { LlmAdapter, LlmMessage } from '../llm.js';
import type { RuleBook } from '../rulebook/types.js';
import type { DirectiveSuccessTracker } from './degrade.js';
import {
  executeCheck,
  executeHp,
  executeResource,
  executeSanity,
  type PcRoster,
} from './executor.js';
import type {
  CheckDirective,
  DamageDirective,
  HealDirective,
  ResourceDirective,
  SanityDirective,
} from './schema.js';
import { DirectiveStreamScanner, type DirectiveScanEvent } from './scan.js';

/**
 * 闭环编排器（T-M3-04，TDD §5.4 处理循环 / ADR-02）。
 *
 * 一次 AI 回合（turn）= 若干次 LLM 请求链：
 *   组装 prompt → 流式请求（增量边广播边喂扫描器）→ 指令块 → 掷骰 → DiceMsg 广播
 *   → SystemMsg{ai_directive_result} 回注 → 以最新落盘态重建 prompt 续写。
 * 指令块为内部协议，流式增量与落盘叙事均按扫描区间剥离（TDD §5.4）：
 * 块外增量即到即发；块内增量不广播，块区间 [start, end) 整段剔除。
 * 续写仅由「本请求执行了检定」或「第 4 次检定被拦截需强制收尾」触发；
 * 每轮检定上限 3 次（MAX_CHECKS_PER_TURN），超限请求被拦并注入禁止再检定元指令
 * （TC-FR-05-006/007）。回注消息经落盘进入下一次 buildMessages——上下文即消息流。
 *
 * 降级链（T-M3-05，R-01）挂接：解析失败/白名单拒绝/执行失败逐次记入滑动窗口；
 * 成功率 < 95% → 下一请求追加少样本示例（TDD §5.4「骨架元指令追加」的等价实现：
 * 管线保持纯函数与黄金用例稳定，示例以追加 system 消息注入，prompt 效果一致）；
 * 少样本生效期间仍失败 → 本回合停用指令协议 + 提示玩家 `.r`（玩家提示走
 * notifyFallback，其余 E-AI-01 告警只达 KP，玩家无感）。
 *
 * 本模块为领域层纯编排：广播/持久化/告警经 ports 注入，不 import gateway（TDD §1.2）。
 */

/** 每轮（一次 AI 回合）允许执行的指令上限（TDD §5.4 循环上限 3 次/轮；T-M8-03 起含全部 op） */
export const MAX_CHECKS_PER_TURN = 3;

/** 第 4 条指令被拦后注入的收尾元指令（TC-FR-05-007） */
export const NO_MORE_CHECKS_META =
  '【元指令】本轮指令请求已达上限，禁止再输出 aidle 指令块，请直接以纯叙事收尾。';

/** 一级降级追加的少样本示例（TDD §5.4 降级链） */
export const FEW_SHOT_EXAMPLES = [
  '【指令块格式示例（严格 JSON，无注释、无尾逗号）】',
  '```aidle',
  '{"op": "check", "target": "pc:alice", "skill": "侦查", "difficulty": "normal", "label": "翻查书桌"}',
  '```',
].join('\n');

export interface AiTurnPorts {
  llm: LlmAdapter;
  /** ChatRequest 参数（模型与上限来自 config；温度 v1 固定由装配侧给出） */
  chat: { model: string; temperature: number; maxTokens: number };
  roster: PcRoster;
  rulebook?: RuleBook;
  /** 缺省 CSPRNG；测试注入确定性源 */
  random?: RandomSource;
  /** R-01 滑动窗口（跨回合共享，挂在房间/会话上） */
  tracker: DirectiveSuccessTracker;
  /** 当前会话状态板（T-M8-03/04 数值效果取值的权威源）；未开团/未载入为 undefined */
  getBoard(): StateBoard | undefined;
  /**
   * 引擎写路径（T-M8-03）：伤害/治疗——在房间队列内对**当前板**现算 clamp patch 并
   * 乐观锁落盘广播。同一轮多条效果指令依次基于最新板累加；返回 null = 板侧拒绝
   * （目标被移除等罕见态），调用方告警。应用先于回注：文案里的 HP 前后值以应用结果为准。
   */
  applyHpEffect(
    key: string,
    kind: 'damage' | 'heal',
    roll: ParsedRoll,
  ): Promise<{ before: number; after: number } | null>;
  /**
   * 引擎写路径（T-M8-04）：理智——损失表档位以**当前 SAN** 为判定目标，损失骰在
   * 队列内对当前板现算扣减；KP 显式 lossHint 覆盖房规表（仍服务端掷）。损失骰的
   * DiceMsg 落盘广播由本端口一并完成（审计先行），返回 null = 板侧拒绝。
   */
  applySanityEffect(
    key: string,
    sanRoll: number,
    lossHint: string | undefined,
    random?: RandomSource,
  ): Promise<{
    lossRoll: ParsedRoll;
    loss: number;
    before: number;
    after: number;
    desc: string;
  } | null>;
  /**
   * 引擎写路径（T-M12-02，FR-38）：资源计数器——在房间队列内对**当前板**现算
   * `clamp(current+delta, 0, max)` patch 并乐观锁落盘广播。不掷骰（消耗量是确定的），
   * 但同样走审计之外的 state:broadcast 通道；返回 null = 板侧拒绝。
   */
  applyResourceEffect(
    key: string,
    name: string,
    delta: number,
  ): Promise<{ before: number; after: number } | null>;
  /** 组装当前 prompt：读盘消息 → 管线 → LlmMessage[]（每请求重建，回注自动入上下文） */
  buildMessages(): Promise<LlmMessage[]>;
  /** 持久化 + 广播 DiceMsg（房间串行队列内，TDD §5.4） */
  emitDice(roll: ParsedRoll): Promise<void>;
  /** 持久化 + 广播 SystemMsg{ai_directive_result} 回注 */
  emitDirectiveResult(content: string): Promise<void>;
  /** 流式增量广播（narration:delta；seq 为触发消息 seq，关联用） */
  emitNarrationDelta(triggerSeq: number, delta: string): void;
  /** 每段叙事收尾：持久化 NarrationMsg + 广播 + narration:done（seq 为落盘消息 seq） */
  finishNarration(triggerSeq: number, content: string, aborted: boolean): Promise<void>;
  /** KP 端告警（E-AI-01，玩家无感；定向 Host） */
  alertKp(code: ErrorCode, message: string): void;
  /**
   * 失败指令块留档（可选端口；测试文档 §12.4：失败块原始文本自动落 data/logs/ 供回归分析）。
   * 仅 parse-error / rejected 调用——截断块不构成一次解析尝试，循环上限拦截不是解析失败，
   * 二者都不入分母（§12.4）也不留档。
   */
  recordDirective?(ev: DirectiveScanEvent): void;
  /** 二级降级的玩家提示（TDD §5.4：提示玩家 .r 手动骰） */
  notifyFallback(): Promise<void>;
}

/**
 * 运行一次 AI 回合：处理完 prompt 链与检定闭环后返回。
 * 每段 LLM 请求产出独立一段 NarrationMsg（检定打断即分段）。
 */
export async function runAiTurn(triggerSeq: number, ports: AiTurnPorts): Promise<void> {
  let executed = 0;
  let wrapUpPending = false;
  let wrapUpDone = false;
  let protocolDisabled = false;

  // 请求次数有确定性上界：续写仅由「执行了检定」（≤3 次）或「强制收尾」（≤1 次）触发
  for (;;) {
    const messages = await ports.buildMessages();
    // 一级降级：窗口成功率 < 95% → 本请求注入少样本示例（TDD §5.4）
    const fewShotActive = ports.tracker.needsFewShot;
    if (fewShotActive) messages.push({ role: 'system', content: FEW_SHOT_EXAMPLES });
    if (wrapUpPending) {
      messages.push({ role: 'system', content: NO_MORE_CHECKS_META });
      wrapUpPending = false;
      wrapUpDone = true;
    }

    const scanner = new DirectiveStreamScanner();
    // 流式剥离状态（TDD §5.4：指令块是 AI 与引擎间的内部协议，不得出现在玩家可见输出）：
    // fullText 为原始全量；emitted 为已广播偏移；narrative 为剥离后叙事（落盘用）。
    let fullText = '';
    let emitted = 0;
    const narrative: string[] = [];
    const emitTo = (end: number): void => {
      if (end <= emitted) return;
      const chunk = fullText.slice(emitted, end);
      narrative.push(chunk);
      ports.emitNarrationDelta(triggerSeq, chunk);
      emitted = end;
    };
    /** 广播到下一个安全点：块外已完成行可发；未完成行去掉缩进后仍是 ```aidle 前缀的，可能是开栅栏雏形，保守等行完 */
    const flushSafeTail = (): void => {
      if (scanner.isInBlock) return;
      const nl = fullText.lastIndexOf('\n');
      const pending = fullText.slice(nl + 1);
      if (!'```aidle'.startsWith(pending.trimStart())) {
        emitTo(fullText.length);
        return;
      }
      emitTo(nl + 1);
    };
    let executedHere = 0;
    let failedHere = false;
    const effects: Promise<void>[] = [];

    const handle = (ev: DirectiveScanEvent): void => {
      // 截断块不计入 R-01（非完整解析尝试，§12.4 分母不含）；块内残留同样不进叙事
      if (ev.kind === 'truncated') {
        emitTo(ev.start);
        emitted = fullText.length;
        return;
      }
      // 指令块本体（含解析失败 / 白名单拒绝的原始块）从叙事剥离：[start, end) 不广播
      emitTo(ev.start);
      emitted = ev.end;

      if (ev.kind === 'directive') {
        // 二级降级停用后忽略指令块：既不执行也不计数（协议对该请求已不生效）
        if (protocolDisabled) return;
        if (executed >= MAX_CHECKS_PER_TURN) {
          if (!wrapUpDone) wrapUpPending = true;
          ports.alertKp('E-AI-01', `指令循环已达上限（${MAX_CHECKS_PER_TURN}/轮），该指令块未执行`);
          return;
        }
        if (ev.directive.op === 'check') {
          const result = executeCheck(ev.directive, {
            roster: ports.roster,
            rulebook: ports.rulebook,
            random: ports.random,
          });
          if (!result.ok) {
            ports.tracker.record(false);
            failedHere = true;
            ports.alertKp(result.code, result.reason);
          } else {
            ports.tracker.record(true);
            executed += 1;
            executedHere += 1;
            const text = directiveResultText(ev.directive, result.roll, result.pcName);
            effects.push(ports.emitDice(result.roll));
            effects.push(ports.emitDirectiveResult(text));
          }
        } else {
          // 数值效果（T-M8-03/04）：damage/heal/sanity——服务端掷骰（防呆校验先行）→
          // 队列内对当前板现算写板（乐观锁落盘 + state:broadcast）→ 回注。失败同样计 R-01。
          const directive = ev.directive;
          const deps = {
            board: ports.getBoard(),
            rulebook: ports.rulebook,
            random: ports.random,
          };
          const recordOk = (): void => {
            ports.tracker.record(true);
            executed += 1;
            executedHere += 1;
          };
          const recordFail = (reason: string): void => {
            ports.tracker.record(false);
            failedHere = true;
            ports.alertKp('E-AI-01', reason);
          };

          if (directive.op === 'resource') {
            // 资源计数器（T-M12-02）：不掷骰，直接队列内 clamp 写板 → 回注
            const result = executeResource(directive, deps);
            if (!result.ok) {
              recordFail(result.reason);
            } else {
              recordOk();
              effects.push(
                (async () => {
                  const applied = await ports.applyResourceEffect(
                    result.key,
                    result.name,
                    result.delta,
                  );
                  if (!applied) {
                    ports.alertKp('E-AI-01', '状态板写入失败，本次资源变动未落盘');
                    return;
                  }
                  await ports.emitDirectiveResult(
                    resourceResultText(directive, result.pcName, result.name, applied),
                  );
                })(),
              );
            }
          } else if (directive.op === 'sanity') {
            const result = executeSanity(directive, deps);
            if (!result.ok) {
              recordFail(result.reason);
            } else {
              recordOk();
              // 检定骰广播 → 队列内查损失表掷损失骰并写板 → 回注（前后值依应用结果）
              effects.push(
                (async () => {
                  await ports.emitDice(result.checkRoll);
                  const applied = await ports.applySanityEffect(
                    result.key,
                    result.checkRoll.total,
                    directive.loss,
                    ports.random,
                  );
                  if (!applied) {
                    ports.alertKp('E-AI-01', '状态板写入失败，本次理智效果未落盘');
                    return;
                  }
                  await ports.emitDirectiveResult(
                    sanityResultText(directive, result.pcName, result.checkRoll, applied),
                  );
                })(),
              );
            }
          } else {
            const result = executeHp(directive, deps);
            if (!result.ok) {
              recordFail(result.reason);
            } else {
              recordOk();
              // 效果骰广播（audit-first）→ 队列内现算写板 → 回注
              effects.push(
                (async () => {
                  await ports.emitDice(result.roll);
                  const applied = await ports.applyHpEffect(result.key, directive.op, result.roll);
                  if (!applied) {
                    ports.alertKp('E-AI-01', '状态板写入失败，本次效果未落盘');
                    return;
                  }
                  await ports.emitDirectiveResult(
                    hpResultText(directive, result.pcName, result.roll, applied),
                  );
                })(),
              );
            }
          }
        }
      } else {
        // parse-error | rejected：E-AI-01，计入 R-01（TDD §11/§5.4）
        ports.tracker.record(false);
        failedHere = true;
        ports.alertKp(ev.code, ev.reason);
        ports.recordDirective?.(ev);
      }

      // 二级降级：少样本在本请求生效仍失败 → 本回合停用协议 + 提示玩家 .r（TDD §5.4 降级链末级）
      if (failedHere && fewShotActive && !protocolDisabled) {
        protocolDisabled = true;
        effects.push(ports.notifyFallback());
      }
    };

    let aborted = false;
    try {
      const response = await ports.llm.chat(
        {
          messages,
          model: ports.chat.model,
          temperature: ports.chat.temperature,
          maxTokens: ports.chat.maxTokens,
        },
        (delta) => {
          fullText += delta;
          for (const ev of scanner.feed(delta)) handle(ev);
          flushSafeTail();
        },
      );
      aborted = response.aborted;
    } catch (err) {
      // E-LLM-01 重试耗尽/不可重试：已收增量保留并标记（E-LLM-02 口径），回合终止
      const code = (err as { code?: ErrorCode }).code ?? 'E-LLM-01';
      ports.alertKp(code, err instanceof Error ? err.message : String(err));
      aborted = true;
    }

    for (const ev of scanner.flush()) handle(ev);
    // 流终：剩余叙事全部广播（truncated 已把 emitted 推到末尾时此处 no-op）
    emitTo(fullText.length);
    await Promise.all(effects);
    await ports.finishNarration(
      triggerSeq,
      `${narrative.join('')}${aborted ? '\n（生成中断）' : ''}`,
      aborted,
    );

    const needsWrapUp = wrapUpPending && !wrapUpDone;
    if (executedHere === 0 && !needsWrapUp) return;
    // 续写：重建 prompt（回注已落盘）再来一轮；强制收尾请求在下一迭代注入元指令
  }
}

/** 回注文案（SystemMsg{ai_directive_result}）：结果与判定等级的人类可读汇总 */
export function directiveResultText(
  directive: CheckDirective,
  roll: ParsedRoll,
  pcName: string,
): string {
  const label = directive.label ? `（${directive.label}）` : '';
  const check = roll.check;
  const verdict = check ? `，${outcomeText(check)}` : '';
  return `【检定】${pcName} ${directive.skill}${label}：${roll.expr} → ${roll.total}${verdict}`;
}

/** 伤害/治疗回注文案（T-M8-03）：骰式、面值与 HP 前后变化（前后值以队列内应用结果为准） */
export function hpResultText(
  directive: DamageDirective | HealDirective,
  pcName: string,
  roll: ParsedRoll,
  applied: { before: number; after: number },
): string {
  const kind = directive.op === 'damage' ? '伤害' : '治疗';
  const label = directive.label ? `（${directive.label}）` : '';
  return `【${kind}】${pcName}${label}：${roll.expr} → ${roll.total}，HP ${applied.before} → ${applied.after}`;
}

/** 理智回注文案（T-M8-04）：检定结果 + 损失表档位 + SAN 前后变化 */
export function sanityResultText(
  directive: SanityDirective,
  pcName: string,
  checkRoll: ParsedRoll,
  applied: { lossRoll: ParsedRoll; loss: number; before: number; after: number; desc: string },
): string {
  const label = directive.label ? `（${directive.label}）` : '';
  const verdict = checkRoll.check ? `，${outcomeText(checkRoll.check)}` : '';
  return (
    `【理智检定】${pcName}${label}：${checkRoll.expr} → ${checkRoll.total}${verdict}，` +
    `${applied.desc} = ${applied.lossRoll.total}，SAN ${applied.before} → ${applied.after}`
  );
}

/** 资源变动回注文案（T-M12-02）：资源名、变动方向与前后余量（不掷骰，无骰值） */
export function resourceResultText(
  directive: ResourceDirective,
  pcName: string,
  name: string,
  applied: { before: number; after: number },
): string {
  const label = directive.label ? `（${directive.label}）` : '';
  const verb = directive.delta > 0 ? '恢复' : '消耗';
  return `【资源】${pcName}${label}：${name} ${verb} ${Math.abs(directive.delta)}，${applied.before} → ${applied.after}`;
}

function outcomeText(check: RollCheck): string {
  switch (check.outcome) {
    case 'critical':
      return '大成功';
    case 'fumble':
      return '大失败';
    case 'fail':
      return '失败';
    default:
      return check.grade === 'hard' ? '困难成功' : check.grade === 'extreme' ? '极难成功' : '成功';
  }
}
