import { describe, expect, it } from 'vitest';
import { DEGRADE_WINDOW_SIZE, DirectiveSuccessTracker } from './degrade.js';

/**
 * T-M3-05：指令协议降级链（R-01 / TDD §5.4）。
 *
 * 窗口口径按测试文档 §12.4：成功 + 解析失败 + 白名单拒绝计入分母，截断块不计
 * （截断不计由扫描器保证——只产出 truncated 事件，编排器不调 record）。
 * 一级降级：成功率 < 95% → 下一请求追加少样本示例。
 */

function fill(tracker: DirectiveSuccessTracker, ok: boolean, times: number): void {
  for (let i = 0; i < times; i += 1) tracker.record(ok);
}

describe('初始与稳态（无失败证据不降级）', () => {
  it('窗口默认 20 次尝试', () => {
    expect(DEGRADE_WINDOW_SIZE).toBe(20);
  });

  it('零尝试：成功率视为 1，不降级（尚无失败证据）', () => {
    const tracker = new DirectiveSuccessTracker();
    expect(tracker.attempts).toBe(0);
    expect(tracker.successRate).toBe(1);
    expect(tracker.needsFewShot).toBe(false);
  });

  it('全成功窗口不降级', () => {
    const tracker = new DirectiveSuccessTracker();
    fill(tracker, true, 20);
    expect(tracker.attempts).toBe(20);
    expect(tracker.successRate).toBe(1);
    expect(tracker.needsFewShot).toBe(false);
  });
});

describe('95% 阈值（严格小于才降级）', () => {
  it('19/20 = 95%：恰好达标不降级', () => {
    const tracker = new DirectiveSuccessTracker();
    fill(tracker, true, 19);
    tracker.record(false);
    expect(tracker.successRate).toBe(0.95);
    expect(tracker.needsFewShot).toBe(false);
  });

  it('18/20 = 90%：跌破阈值降级', () => {
    const tracker = new DirectiveSuccessTracker();
    fill(tracker, true, 18);
    fill(tracker, false, 2);
    expect(tracker.successRate).toBe(0.9);
    expect(tracker.needsFewShot).toBe(true);
  });

  it('首次尝试即失败（0/1）：立即降级', () => {
    const tracker = new DirectiveSuccessTracker();
    tracker.record(false);
    expect(tracker.needsFewShot).toBe(true);
  });
});

describe('滑动窗口（旧记录被挤出，可自愈）', () => {
  it('失败后连续 20 次成功 → 故障记录滑出窗口，恢复不降级', () => {
    const tracker = new DirectiveSuccessTracker();
    tracker.record(false);
    expect(tracker.needsFewShot).toBe(true);
    fill(tracker, true, 20);
    expect(tracker.attempts).toBe(20); // 窗口封顶，最早的失败已被丢弃
    expect(tracker.needsFewShot).toBe(false);
  });

  it('自定义窗口大小：需连续成功 windowSize 次才能把失败挤出', () => {
    const tracker = new DirectiveSuccessTracker(10);
    fill(tracker, true, 9);
    tracker.record(false);
    expect(tracker.successRate).toBe(0.9);
    expect(tracker.needsFewShot).toBe(true);

    fill(tracker, true, 9); // 窗口里那次失败还在
    expect(tracker.needsFewShot).toBe(true);
    tracker.record(true); // 第 10 次成功把失败挤出窗口
    expect(tracker.attempts).toBe(10);
    expect(tracker.needsFewShot).toBe(false);
  });

  it('窗口为 3 时逐条挤出最旧记录', () => {
    const tracker = new DirectiveSuccessTracker(3);
    fill(tracker, true, 3);
    tracker.record(false); // 窗口 [true, true, false] = 2/3
    expect(tracker.successRate).toBeCloseTo(2 / 3);
    expect(tracker.needsFewShot).toBe(true);

    fill(tracker, true, 3); // 逐条挤出：[false, true, true] → [true, true, true]
    expect(tracker.needsFewShot).toBe(false);
  });
});

describe('跨回合共享（tracker 挂在房间/会话上）', () => {
  it('多次回合累积记录，不随单回合结束清零', () => {
    const tracker = new DirectiveSuccessTracker();
    fill(tracker, true, 5); // 回合 1
    fill(tracker, false, 1);
    fill(tracker, true, 4); // 回合 2
    expect(tracker.attempts).toBe(10);
    expect(tracker.successRate).toBe(0.9);
    expect(tracker.needsFewShot).toBe(true);
  });
});
