import { randomInt } from 'node:crypto';

/**
 * 随机源抽象（T-P-03，NFR-04）。
 *
 * 默认实现 crypto.randomInt（CSPRNG）：掷骰永远由服务端产生，无用户可控种子路径
 * （TDD §8）。测试经接口注入确定性源（TC-NFR-04-003 可测性保证）。
 * 语义：int(min, max) 返回 [min, max] 闭区间内的均匀整数。
 */
export interface RandomSource {
  int(min: number, max: number): number;
}

export function createCsprngRandom(): RandomSource {
  return {
    int(min: number, max: number): number {
      // crypto.randomInt 上界开区间，此处对外为闭区间语义
      return randomInt(min, max + 1);
    },
  };
}
