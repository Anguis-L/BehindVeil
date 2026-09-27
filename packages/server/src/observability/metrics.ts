/**
 * 进程内指标收集器（T-M6-03 / T-M6-05 服务端，FR-13 / R-01 / R-02；TDD §9）。
 *
 * 覆盖 TDD §9 要求的四类指标：
 * - 指令解析成功率（R-01 口径：成功 + 解析失败 + 白名单拒绝，截断块不计）
 * - token 消耗（输入 / 输出分开累计，按 §12 成本模型折算人民币）
 * - 骰子总数（含暗骰计数）
 * - LLM 延迟分布（p50 / p95 / max / avg）
 *
 * 两条刻意的设计约束：
 * 1. **纯内存、无 IO**：指标不做持久化、不碰文件系统——它是运维旁路，绝不能反过来
 *    影响跑团主链路（与指令留档同一口径：旁路失败不影响回合）。
 * 2. **有界**：延迟样本只保留最近 LATENCY_SAMPLE_LIMIT 个，长团内存不随轮次无限增长。
 *
 * 指令成功率**不在本模块统计**——网关的 DirectiveSuccessTracker 已是 R-01 唯一口径
 * （GatewayHandle.directiveStats()），此处只负责承载与汇总，避免两套数字打架。
 */

/**
 * 延迟样本上限（最近 N 次 LLM 调用）。超出即丢弃最旧的样本：
 * 分位数只需要"最近的分布形态"，300 轮长团若全留会让内存随轮次线性增长。
 */
export const LATENCY_SAMPLE_LIMIT = 200;

/**
 * 成本单价（元 / 1K tokens），v1 固定常量，不做配置项（避免过度设计）。
 *
 * 出处：TDD §12 成本模型——4h / 300 轮 ≈ 1.8M 输入 + 0.3M 输出 → DeepSeek 级 ≈ ¥5–15。
 * 按 DeepSeek-V3 官方定价（输入 ¥2 / 1M、输出 ¥8 / 1M）折算即 ¥3.6 + ¥2.4 = ¥6，
 * 落在文档给出的区间内；provider 实际单价不同时，本值只是**量级估算**，
 * 用于 R-02「成本失控」的早期预警，不是账单。
 */
export const COST_CNY_PER_1K_INPUT = 0.002;
export const COST_CNY_PER_1K_OUTPUT = 0.008;

/** 指令解析成功率（R-01） */
export interface DirectiveStats {
  attempts: number;
  successes: number;
  /** 无尝试时为 1——尚无失败证据，与 DirectiveSuccessTracker.totals 同口径 */
  rate: number;
}

/** 累计口径（统计方只给分子分母，rate 由本模块按 R-01 口径算） */
export interface DirectiveTotals {
  attempts: number;
  successes: number;
}

export interface DiceStats {
  total: number;
  hidden: number;
}

export interface LatencyStats {
  p50: number;
  p95: number;
  max: number;
  avg: number;
}

export interface LlmStats {
  calls: number;
  failures: number;
  tokensIn: number;
  tokensOut: number;
  latencyMs: LatencyStats;
}

export interface CostStats {
  estimatedCny: number;
}

/** `GET /metrics` 的响应形状（全局口径，不区分房间） */
export interface GlobalMetricsSnapshot {
  uptimeSec: number;
  directives: DirectiveStats;
  dice: DiceStats;
  llm: LlmStats;
}

/** `kp:metricsResult` 的载荷形状（会话级，供房内 KP 控制台） */
export interface SessionMetricsSnapshot {
  sessionId: string;
  directives: DirectiveStats;
  dice: DiceStats;
  llm: LlmStats;
  cost: CostStats;
}

/** LLM usage 的窄化形状（只取本模块需要的两个量，与 domain/llm.ts ChatUsage 兼容） */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

const EMPTY_LATENCY: LatencyStats = { p50: 0, p95: 0, max: 0, avg: 0 };

/**
 * 分位数（最近秩法 / nearest-rank，不做插值）。
 *
 * 取第 `ceil(p × n)` 个样本（1 起）作为分位值——样本量小（≤200）时线性插值会凭空
 * 造出一个"没发生过的延迟值"，对延迟这种右偏分布尤其失真；最近秩法保证返回值
 * 一定是真实观测到的样本。空样本返回 0。
 */
export function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(p * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] ?? 0;
}

/** R-01 成功率：无尝试记为 1（尚无失败证据，与 tracker 口径一致） */
export function directiveRate(attempts: number, successes: number): number {
  return attempts === 0 ? 1 : successes / attempts;
}

/** 成本估算（§12 模型）：输入输出分开计价，保留 4 位小数避免浮点噪声 */
export function estimateCostCny(tokensIn: number, tokensOut: number): number {
  const cny =
    (tokensIn / 1000) * COST_CNY_PER_1K_INPUT + (tokensOut / 1000) * COST_CNY_PER_1K_OUTPUT;
  return Math.round(cny * 10_000) / 10_000;
}

/** 一组计数器 + 有界延迟样本（全局桶与会话桶共用同一套累加逻辑） */
class MetricsBucket {
  private diceTotal = 0;
  private diceHidden = 0;
  private llmCalls = 0;
  private llmFailures = 0;
  private tokensIn = 0;
  private tokensOut = 0;
  private samples: number[] = [];

  recordDice(hidden: boolean): void {
    this.diceTotal += 1;
    if (hidden) this.diceHidden += 1;
  }

  /** 成功（含流中断）调用：记耗时与 usage；usage 缺省（provider 未回）时只记耗时 */
  recordLlmCall(latencyMs: number, usage?: TokenUsage): void {
    this.llmCalls += 1;
    if (usage) {
      this.tokensIn += usage.promptTokens;
      this.tokensOut += usage.completionTokens;
    }
    this.pushSample(latencyMs);
  }

  /** 失败调用：同样记耗时（用户体感到的等待真实发生了），但不记 token */
  recordLlmFailure(latencyMs: number): void {
    this.llmFailures += 1;
    this.pushSample(latencyMs);
  }

  private pushSample(latencyMs: number): void {
    this.samples.push(latencyMs);
    if (this.samples.length > LATENCY_SAMPLE_LIMIT) this.samples.shift();
  }

  get dice(): DiceStats {
    return { total: this.diceTotal, hidden: this.diceHidden };
  }

  get llm(): LlmStats {
    return {
      calls: this.llmCalls,
      failures: this.llmFailures,
      tokensIn: this.tokensIn,
      tokensOut: this.tokensOut,
      latencyMs: latencyStats(this.samples),
    };
  }
}

function latencyStats(samples: number[]): LatencyStats {
  if (samples.length === 0) return { ...EMPTY_LATENCY };
  const sorted = [...samples].sort((a, b) => a - b);
  let sum = 0;
  for (const value of sorted) sum += value;
  return {
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    max: sorted[sorted.length - 1] ?? 0,
    avg: sum / sorted.length,
  };
}

/**
 * 进程内指标收集器：全局桶 + 按会话分桶（会话级供房内 `kp:metricsResult` 使用）。
 *
 * 会话桶只在真正掷过骰 / 调过 LLM 后才创建，空房间不占内存。
 */
export class MetricsCollector {
  private readonly startedAt: number;
  private readonly clock: () => number;
  private readonly global = new MetricsBucket();
  private readonly sessions = new Map<string, MetricsBucket>();

  /** clock 可注入：单测需要一个确定的"现在"来断言 uptimeSec */
  constructor(clock: () => number = Date.now) {
    this.clock = clock;
    this.startedAt = clock();
  }

  /** 进程已运行秒数（向下取整） */
  get uptimeSec(): number {
    return Math.floor((this.clock() - this.startedAt) / 1000);
  }

  /** 掷骰计数（玩家骰与 AI 检定骰同一入口；hidden=true 计入暗骰） */
  recordDice(sessionId: string, hidden: boolean): void {
    this.global.recordDice(hidden);
    this.bucketFor(sessionId).recordDice(hidden);
  }

  /** LLM 调用成功：记耗时与 usage */
  recordLlmCall(sessionId: string, latencyMs: number, usage?: TokenUsage): void {
    this.global.recordLlmCall(latencyMs, usage);
    this.bucketFor(sessionId).recordLlmCall(latencyMs, usage);
  }

  /** LLM 调用失败（重试耗尽 / provider 报错） */
  recordLlmFailure(sessionId: string, latencyMs: number): void {
    this.global.recordLlmFailure(latencyMs);
    this.bucketFor(sessionId).recordLlmFailure(latencyMs);
  }

  /** `GET /metrics` 用：全局口径快照 */
  snapshot(directives: DirectiveTotals): GlobalMetricsSnapshot {
    return {
      uptimeSec: this.uptimeSec,
      directives: {
        attempts: directives.attempts,
        successes: directives.successes,
        rate: directiveRate(directives.attempts, directives.successes),
      },
      dice: this.global.dice,
      llm: this.global.llm,
    };
  }

  /** `kp:metricsResult` 用：会话级快照（含该会话的累计成本估算） */
  sessionSnapshot(sessionId: string, directives: DirectiveTotals): SessionMetricsSnapshot {
    const bucket = this.sessions.get(sessionId) ?? new MetricsBucket();
    const llm = bucket.llm;
    return {
      sessionId,
      directives: {
        attempts: directives.attempts,
        successes: directives.successes,
        rate: directiveRate(directives.attempts, directives.successes),
      },
      dice: bucket.dice,
      llm,
      cost: { estimatedCny: estimateCostCny(llm.tokensIn, llm.tokensOut) },
    };
  }

  private bucketFor(sessionId: string): MetricsBucket {
    let bucket = this.sessions.get(sessionId);
    if (!bucket) {
      bucket = new MetricsBucket();
      this.sessions.set(sessionId, bucket);
    }
    return bucket;
  }
}
