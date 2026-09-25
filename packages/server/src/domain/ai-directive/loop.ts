import type { ErrorCode, RollCheck } from '@behindveil/shared';
import type { ParsedRoll } from '../dice/evaluator.js';
import { createCsprngRandom, type RandomSource } from '../dice/random.js';
import type { LlmAdapter, LlmMessage } from '../llm.js';
import type { RuleBook } from '../rulebook/types.js';
import type { DirectiveSuccessTracker } from './degrade.js';
import { executeCheck, type PcRoster } from './executor.js';
import type { CheckDirective } from './schema.js';
import { DirectiveStreamScanner, type DirectiveScanEvent } from './scan.js';

/**
 * 闭环编排器（T-M3-04，TDD §5.4 处理循环 / ADR-02）。
 *
 * 一次 AI 回合（turn）= 若干次 LLM 请求链：
 *   组装 prompt → 流式请求（增量边广播边喂扫描器）→ 指令块 → 掷骰 → DiceMsg 广播
 *   → SystemMsg{ai_directive_result} 回注 → 以最新落盘态重建 prompt 续写。
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

/** 每轮（一次 AI 回合）允许执行的检定上限（TDD §5.4：循环上限 3 次/轮） */
export const MAX_CHECKS_PER_TURN = 3;

/** 第 4 次检定被拦后注入的收尾元指令（TC-FR-05-007） */
export const NO_MORE_CHECKS_META =
  '【元指令】本轮检定请求已达上限，禁止再输出 aidle 指令块，请直接以纯叙事收尾。';

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
    const content: string[] = [];
    let executedHere = 0;
    let failedHere = false;
    const effects: Promise<void>[] = [];

    const handle = (ev: DirectiveScanEvent): void => {
      // 截断块不计入 R-01（非完整解析尝试，§12.4 分母不含）
      if (ev.kind === 'truncated') return;

      if (ev.kind === 'directive') {
        // 二级降级停用后忽略指令块：既不执行也不计数（协议对该请求已不生效）
        if (protocolDisabled) return;
        if (executed >= MAX_CHECKS_PER_TURN) {
          if (!wrapUpDone) wrapUpPending = true;
          ports.alertKp('E-AI-01', `检定循环已达上限（${MAX_CHECKS_PER_TURN}/轮），该指令块未执行`);
          return;
        }
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
        // parse-error | rejected：E-AI-01，计入 R-01（TDD §11/§5.4）
        ports.tracker.record(false);
        failedHere = true;
        ports.alertKp(ev.code, ev.reason);
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
          content.push(delta);
          ports.emitNarrationDelta(triggerSeq, delta);
          for (const ev of scanner.feed(delta)) handle(ev);
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
    await Promise.all(effects);
    await ports.finishNarration(
      triggerSeq,
      `${content.join('')}${aborted ? '\n（生成中断）' : ''}`,
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
