import { describe, expect, it } from 'vitest';
import { validateDirective } from './validate.js';

/**
 * T-M3-02：op 白名单校验（TDD §5.4，v1 仅 check）。
 * 对应 TC-FR-05-001（合法块解析为结构化对象）、TC-FR-05-005（白名单拒绝 + E-AI-01）。
 */

const fullDirective = {
  op: 'check',
  target: 'pc:alice',
  skill: '侦查',
  difficulty: 'normal',
  label: '翻查书桌',
};

describe('合法指令块（TC-FR-05-001）', () => {
  it('全字段解析为结构化对象', () => {
    const verdict = validateDirective(fullDirective);
    expect(verdict).toEqual({ ok: true, directive: fullDirective });
  });

  it('difficulty 缺省为 normal（COC7 常规成功）', () => {
    const verdict = validateDirective({ op: 'check', target: 'pc:alice', skill: '侦查' });
    expect(verdict.ok && verdict.directive.op === 'check' && verdict.directive.difficulty).toBe(
      'normal',
    );
  });

  it('label 可省略；skill/target 自动去首尾空白', () => {
    const verdict = validateDirective({ op: 'check', target: ' pc:alice ', skill: ' 侦查 ' });
    expect(verdict.ok && verdict.directive).toEqual({
      op: 'check',
      target: 'pc:alice',
      skill: '侦查',
      difficulty: 'normal',
    });
  });
});

describe('白名单拒绝（TC-FR-05-005，E-AI-01）', () => {
  it.each([
    ['未知 op roll', { ...fullDirective, op: 'roll' }, '未知 op'],
    ['未知 op emote', { ...fullDirective, op: 'emote' }, '未知 op'],
    ['op 缺失', { target: 'pc:alice', skill: '侦查' }, '未知 op'],
    ['非法 target 无前缀', { op: 'check', target: 'alice', skill: '侦查' }, 'target'],
    ['非法 target 空标识', { op: 'check', target: 'pc:', skill: '侦查' }, 'target'],
    ['未知字段 skillValue 夹带数值', { ...fullDirective, skillValue: 80 }, 'skillValue'],
    ['未知字段 expression', { ...fullDirective, expression: '1d100' }, 'expression'],
    ['skill 缺失', { op: 'check', target: 'pc:alice' }, 'skill'],
    ['skill 空串', { op: 'check', target: 'pc:alice', skill: '  ' }, 'skill'],
    ['difficulty 越界', { ...fullDirective, difficulty: 'veryhard' }, 'difficulty'],
  ])('%s → 拒绝且原因可读', (_name, input, reasonPart) => {
    const verdict = validateDirective(input);
    expect(verdict).toMatchObject({ ok: false, code: 'E-AI-01' });
    if (!verdict.ok) expect(verdict.reason).toContain(reasonPart);
  });

  it.each([
    ['字符串', '"check"'],
    ['数组', ['op']],
    ['null', null],
    ['数字', 42],
  ])('非对象输入 %s → 拒绝', (_name, input) => {
    expect(validateDirective(input)).toMatchObject({ ok: false, code: 'E-AI-01' });
  });

  it('拒绝不产出结构化指令（不掷骰的接口前提）', () => {
    const verdict = validateDirective({ ...fullDirective, op: 'roll' });
    expect('directive' in verdict).toBe(false);
  });
});

describe('数值效果指令（T-M8-03/04 白名单扩值，设计 §5.4）', () => {
  it.each([
    ['damage 合法', { op: 'damage', target: 'pc:alice', expr: '1d8+2', label: '哥布林弯刀' }],
    ['heal 合法', { op: 'heal', target: 'pc:alice', expr: '2d4+2' }],
    ['sanity 合法（缺省房规损失表）', { op: 'sanity', target: 'pc:alice' }],
    ['sanity 带 KP 损失表达式', { op: 'sanity', target: 'pc:alice', loss: '1d6' }],
  ])('%s → 通过', (_name, input) => {
    expect(validateDirective(input)).toMatchObject({ ok: true });
  });

  it.each([
    [
      'resource 合法（消耗一环法术位）',
      { op: 'resource', target: 'pc:alice', name: '一环法术位', delta: -1 },
    ],
    ['resource 合法（恢复）', { op: 'resource', target: 'pc:alice', name: '箭矢', delta: 5 }],
    [
      'resource 带 label',
      { op: 'resource', target: 'pc:alice', name: '箭矢', delta: -2, label: '射一箭' },
    ],
  ])('%s → 通过', (_name, input) => {
    expect(validateDirective(input)).toMatchObject({ ok: true });
  });

  // 防篡改线的位置（T-M12-02）：只收相对变动量，绝对数值字段一律拒——
  // AI 能说「消耗一个」，不能说「现在剩几个」
  it.each([
    [
      'resource 夹带 current',
      { op: 'resource', target: 'pc:alice', name: '箭矢', delta: -1, current: 3 },
      'current',
    ],
    [
      'resource 夹带 value',
      { op: 'resource', target: 'pc:alice', name: '箭矢', delta: -1, value: 3 },
      'value',
    ],
    [
      'resource 夹带 amount',
      { op: 'resource', target: 'pc:alice', name: '箭矢', delta: -1, amount: 3 },
      'amount',
    ],
    ['resource 缺 name', { op: 'resource', target: 'pc:alice', delta: -1 }, 'name'],
    ['resource 缺 delta', { op: 'resource', target: 'pc:alice', name: '箭矢' }, 'delta'],
  ])('%s → E-AI-01 拒绝（strictObject 防呆）', (_name, input, reasonPart) => {
    const verdict = validateDirective(input);
    expect(verdict).toMatchObject({ ok: false, code: 'E-AI-01' });
    if (!verdict.ok) expect(verdict.reason).toContain(reasonPart);
  });

  it.each([
    [
      'resource 合法（消耗一环法术位）',
      { op: 'resource', target: 'pc:alice', name: '一环法术位', delta: -1 },
    ],
    ['resource 合法（恢复）', { op: 'resource', target: 'pc:alice', name: '箭矢', delta: 5 }],
    [
      'resource 带 label',
      { op: 'resource', target: 'pc:alice', name: '箭矢', delta: -2, label: '射一箭' },
    ],
  ])('%s → 通过', (_name, input) => {
    expect(validateDirective(input)).toMatchObject({ ok: true });
  });

  // 防篡改线的位置（T-M12-02）：只收相对变动量，绝对数值字段一律拒——
  // AI 能说「消耗一个」，不能说「现在剩几个」
  it.each([
    [
      'resource 夹带 current',
      { op: 'resource', target: 'pc:alice', name: '箭矢', delta: -1, current: 3 },
      'current',
    ],
    [
      'resource 夹带 value',
      { op: 'resource', target: 'pc:alice', name: '箭矢', delta: -1, value: 3 },
      'value',
    ],
    [
      'resource 夹带 amount',
      { op: 'resource', target: 'pc:alice', name: '箭矢', delta: -1, amount: 3 },
      'amount',
    ],
    ['resource 缺 name', { op: 'resource', target: 'pc:alice', delta: -1 }, 'name'],
    ['resource 缺 delta', { op: 'resource', target: 'pc:alice', name: '箭矢' }, 'delta'],
  ])('%s → E-AI-01 拒绝（strictObject 防呆）', (_name, input, reasonPart) => {
    const verdict = validateDirective(input);
    expect(verdict).toMatchObject({ ok: false, code: 'E-AI-01' });
    if (!verdict.ok) expect(verdict.reason).toContain(reasonPart);
  });

  it.each([
    ['damage 夹带 result', { op: 'damage', target: 'pc:alice', expr: '1d8', result: 7 }, 'result'],
    ['damage 夹带 total', { op: 'damage', target: 'pc:alice', expr: '1d8', total: 7 }, 'total'],
    ['heal 夹带 hp', { op: 'heal', target: 'pc:alice', expr: '1d4', hp: 10 }, 'hp'],
    ['sanity 夹带 sanLost', { op: 'sanity', target: 'pc:alice', sanLost: 3 }, 'sanLost'],
    ['damage expr 空白', { op: 'damage', target: 'pc:alice', expr: '   ' }, 'expr'],
    ['damage 缺 expr', { op: 'damage', target: 'pc:alice' }, 'expr'],
  ])('%s → E-AI-01 拒绝（strictObject 防呆）', (_name, input, reasonPart) => {
    const verdict = validateDirective(input);
    expect(verdict).toMatchObject({ ok: false, code: 'E-AI-01' });
    if (!verdict.ok) expect(verdict.reason).toContain(reasonPart);
  });
});

describe('resource 指令的语义边界（T-M12-02）', () => {
  it('delta 非整数 → 拒绝（法术位不能消耗半个）', () => {
    const verdict = validateDirective({
      op: 'resource',
      target: 'pc:alice',
      name: '箭矢',
      delta: -1.5,
    });
    expect(verdict).toMatchObject({ ok: false, code: 'E-AI-01' });
  });

  it('未知 op 的白名单提示串随 OP_SCHEMAS 派生（加 resource 后文案同步）', () => {
    const verdict = validateDirective({ op: 'teleport', target: 'pc:alice' });
    expect(verdict).toMatchObject({ ok: false, code: 'E-AI-01' });
    if (!verdict.ok) expect(verdict.reason).toContain('resource');
  });
});

describe('resource 指令的语义边界（T-M12-02）', () => {
  it('delta 非整数 → 拒绝（法术位不能消耗半个）', () => {
    const verdict = validateDirective({
      op: 'resource',
      target: 'pc:alice',
      name: '箭矢',
      delta: -1.5,
    });
    expect(verdict).toMatchObject({ ok: false, code: 'E-AI-01' });
  });

  it('未知 op 的白名单提示串随 OP_SCHEMAS 派生（加 resource 后文案同步）', () => {
    const verdict = validateDirective({ op: 'teleport', target: 'pc:alice' });
    expect(verdict).toMatchObject({ ok: false, code: 'E-AI-01' });
    if (!verdict.ok) expect(verdict.reason).toContain('resource');
  });
});
