/**
 * 指令协议降级链状态（T-M3-05，R-01 / TDD §5.4）。
 *
 * 滑动窗口记录最近 N 次指令块解析尝试（成功 / 失败；分母口径见测试文档 §12.4：
 * 成功 + 解析失败 + 白名单拒绝，截断块不计）。成功率 < 95% → 降级一级：
 * 下一请求在 prompt 追加少样本示例（TDD §5.4「骨架元指令追加少样本示例」）。
 */
export const DEGRADE_WINDOW_SIZE = 20;

/** 一级降级阈值：成功率 < 95%（施工文档 T-M3-05） */
const FEW_SHOT_THRESHOLD = 0.95;

export class DirectiveSuccessTracker {
  private readonly results: boolean[] = [];

  constructor(private readonly windowSize: number = DEGRADE_WINDOW_SIZE) {}

  record(success: boolean): void {
    this.results.push(success);
    if (this.results.length > this.windowSize) this.results.shift();
  }

  get attempts(): number {
    return this.results.length;
  }

  /** 当前窗口成功率（无尝试时为 1——尚无失败证据，不降级） */
  get successRate(): number {
    if (this.results.length === 0) return 1;
    return this.results.filter(Boolean).length / this.results.length;
  }

  /** 一级降级判定：窗口内成功率 < 95% → 请求侧注入少样本示例 */
  get needsFewShot(): boolean {
    return this.successRate < FEW_SHOT_THRESHOLD;
  }
}
