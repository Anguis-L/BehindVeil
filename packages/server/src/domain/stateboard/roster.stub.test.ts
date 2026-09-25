import { describe, expect, it } from 'vitest';
import { createRosterStub } from './roster.stub.js';
import type { PcRoster } from '../ai-directive/executor.js';

/**
 * T-M3-03a：PC 名册内存 stub（@temp，M5 T-M5-04 替换）。
 * 覆盖检定执行器的取值路径：命中 / 查无人 / 查无技能。
 */

describe('createRosterStub（T-M3-03a）', () => {
  it('实现 PcRoster 端口（结构化替换的前提）', () => {
    const roster: PcRoster = createRosterStub();
    expect(roster.skillValue).toBeTypeOf('function');
  });

  it('样例 PC alice 侦查 60，携带展示名', () => {
    expect(createRosterStub().skillValue('pc:alice', '侦查')).toEqual({
      found: true,
      value: 60,
      name: '爱丽丝',
    });
  });

  it('样例 PC bob 攀爬 65', () => {
    expect(createRosterStub().skillValue('pc:bob', '攀爬')).toEqual({
      found: true,
      value: 65,
      name: '鲍勃',
    });
  });

  it.each([
    ['不存在的 PC', 'pc:carol', '侦查'],
    ['无 pc: 前缀的目标', 'alice', '侦查'],
  ])('%s → pc-not-found', (_name, target, skill) => {
    expect(createRosterStub().skillValue(target, skill)).toEqual({
      found: false,
      reason: 'pc-not-found',
    });
  });

  it('存在的 PC 无此技能 → skill-not-found', () => {
    expect(createRosterStub().skillValue('pc:alice', '攀爬')).toEqual({
      found: false,
      reason: 'skill-not-found',
    });
  });
});
