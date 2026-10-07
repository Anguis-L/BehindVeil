import { describe, expect, it } from 'vitest';
import { GenericRuleSchema, type GenericRule } from '@behindveil/shared';
import { createRuleBook, ruleBookIdOf } from './index.js';
import { compileWhen, createGenericRuleBook, GenericRuleBook, genericQuickRef } from './generic.js';
import type { RuleBook } from './types.js';

/**
 * generic 规则书判定向量（v3 T-M13-01/02，G-M13「generic 判定向量全绿」）：
 * 覆盖边界 / when 文法 / 档表命中顺序 / 平局三口径 / 对抗 / 审计语义同构。
 */

const config = (overrides: Partial<GenericRule> = {}): GenericRule =>
  GenericRuleSchema.parse({ dice: '2d6', op: '>=', ...overrides });

describe('when 文法（受限：只比 raw/total，手写解析）', () => {
  it('单比较：raw/total × 四向比较与 =', () => {
    expect(compileWhen('raw>=20')({ raw: 20, total: 25 })).toBe(true);
    expect(compileWhen('raw>=20')({ raw: 19, total: 25 })).toBe(false);
    expect(compileWhen('total<=6')({ raw: 2, total: 5 })).toBe(true);
    expect(compileWhen('total<6')({ raw: 2, total: 6 })).toBe(false);
    expect(compileWhen('total>6')({ raw: 2, total: 7 })).toBe(true);
    expect(compileWhen('total=7')({ raw: 3, total: 7 })).toBe(true);
    expect(compileWhen('total==7')({ raw: 3, total: 7 })).toBe(true);
    expect(compileWhen('total == 7')({ raw: 3, total: 8 })).toBe(false);
  });

  it('布尔连接：&& 优先于 ||，容许空白', () => {
    const expr = compileWhen('total>=10 && raw>=8 || raw=1');
    expect(expr({ raw: 10, total: 12 })).toBe(true); // 第一支
    expect(expr({ raw: 1, total: 3 })).toBe(true); // 第二支
    expect(expr({ raw: 3, total: 12 })).toBe(false); // total 够但 raw 不够
    expect(expr({ raw: 9, total: 11 })).toBe(true);
  });

  it('raw 为 null（无明确主骰）时 raw 类条件不命中，total 类照常', () => {
    const expr = compileWhen('raw>=20 || total>=10');
    expect(expr({ raw: null, total: 12 })).toBe(true);
    expect(expr({ raw: null, total: 5 })).toBe(false);
  });

  it('文法外一律 RangeError：未知标识 / 缺比较符 / 缺数字 / 残余 / 悬空连接符', () => {
    expect(() => compileWhen('skill>=20')).toThrow(RangeError);
    expect(() => compileWhen('raw>=')).toThrow(RangeError);
    expect(() => compileWhen('raw abc')).toThrow(RangeError);
    expect(() => compileWhen('raw>=20 extra')).toThrow(RangeError);
    expect(() => compileWhen('raw>=20 &&')).toThrow(RangeError);
    expect(() => compileWhen('|| raw>=20')).toThrow(RangeError);
    expect(() => compileWhen('')).toThrow(RangeError);
  });
});

describe('GenericRuleBook 构造校验（装载时编译，坏配置即抛）', () => {
  it('主骰式非法 → RangeError', () => {
    expect(() => new GenericRuleBook(config({ dice: 'not-dice' }))).toThrow(RangeError);
  });

  it('主骰式带判定后缀 → RangeError（目标值来自检定请求，不在配置里）', () => {
    expect(() => new GenericRuleBook(config({ dice: '2d6>=7' }))).toThrow(RangeError);
  });

  it('档表 when 文法错误 → RangeError', () => {
    expect(
      () => new GenericRuleBook(config({ grades: [{ name: 'critical', when: 'hp>=10' }] })),
    ).toThrow(RangeError);
  });

  it('合法配置构造成功，defaultKind 取 kinds[0]', () => {
    const book = new GenericRuleBook(config({ kinds: ['save', 'check'] }));
    expect(book.defaultKind).toBe('save');
    expect(book.id).toBe('generic');
  });
});

describe('装载编译缓存（ADR-3-08：同一配置只编译一次）', () => {
  it('同配置（键序无关）命中同一实例', () => {
    const a = createGenericRuleBook(config({ grades: [{ name: 'critical', when: 'total>=10' }] }));
    const b = createGenericRuleBook(
      GenericRuleSchema.parse({
        op: '>=',
        dice: '2d6',
        grades: [{ name: 'critical', when: 'total>=10' }],
      }),
    );
    expect(b).toBe(a);
  });

  it('不同配置得到不同实例', () => {
    const a = createGenericRuleBook(config());
    const b = createGenericRuleBook(config({ dice: '1d20' }));
    expect(b).not.toBe(a);
  });
});

describe('parseCheck（判定后缀解析，op 透传）', () => {
  it('后缀 op/target 透传；种类缺省 kinds[0]，难度缺省 normal', () => {
    const book = new GenericRuleBook(config({ kinds: ['check'] }));
    const parsed = book.parseCheck('2d6+1>=7');
    expect(parsed).not.toBeNull();
    expect(parsed?.check).toMatchObject({
      kind: 'check',
      target: 7,
      difficulty: 'normal',
      op: '>=',
    });
  });

  it('ctx 覆盖种类与难度；无后缀返回 null（纯骰值）', () => {
    const book = new GenericRuleBook(config({ kinds: ['check', 'save'] }));
    expect(book.parseCheck('2d6=7', { kind: 'save', difficulty: 'hard' })?.check).toMatchObject({
      kind: 'save',
      difficulty: 'hard',
      op: '=',
    });
    expect(book.parseCheck('2d6+1')).toBeNull();
  });
});

describe('adjudicate（布尔判定 + 档表）', () => {
  it('无档表：按 op 比对 total，outcome 限 success/fail', () => {
    const book = new GenericRuleBook(config());
    expect(
      book.adjudicate({ total: 7, raw: 4 }, { kind: 'check', target: 7, difficulty: 'normal' }),
    ).toEqual({
      outcome: 'success',
      grade: 'normal',
    });
    expect(
      book.adjudicate({ total: 6, raw: 3 }, { kind: 'check', target: 7, difficulty: 'normal' }),
    ).toEqual({
      outcome: 'fail',
      grade: 'normal',
    });
    expect(
      book.adjudicate(
        { total: 7, raw: 4 },
        { kind: 'check', target: 7, difficulty: 'normal', op: '=' },
      ),
    ).toEqual({
      outcome: 'success',
      grade: 'normal',
    });
    const le = new GenericRuleBook(config({ op: '<=' }));
    expect(
      le.adjudicate({ total: 5, raw: 5 }, { kind: 'check', target: 8, difficulty: 'normal' }),
    ).toEqual({
      outcome: 'success',
      grade: 'normal',
    });
  });

  it('骰式后缀 op 优先于配置方向', () => {
    const book = new GenericRuleBook(config({ op: '>=' }));
    expect(
      book.adjudicate(
        { total: 5, raw: 5 },
        { kind: 'check', target: 8, difficulty: 'normal', op: '<=' },
      ),
    ).toEqual({ outcome: 'success', grade: 'normal' });
  });

  it('档表按序首个命中生效：命中即改判，不再走布尔比较', () => {
    const book = new GenericRuleBook(
      config({
        grades: [
          { name: 'critical', when: 'total>=10' },
          { name: 'fumble', when: 'total<=3' },
        ],
      }),
    );
    expect(
      book.adjudicate({ total: 12, raw: 6 }, { kind: 'check', target: 7, difficulty: 'normal' }),
    ).toEqual({
      outcome: 'critical',
      grade: 'normal',
    });
    expect(
      book.adjudicate({ total: 3, raw: 1 }, { kind: 'check', target: 7, difficulty: 'normal' }),
    ).toEqual({
      outcome: 'fumble',
      grade: 'normal',
    });
    expect(
      book.adjudicate({ total: 8, raw: 4 }, { kind: 'check', target: 7, difficulty: 'normal' }),
    ).toEqual({
      outcome: 'success',
      grade: 'normal',
    });
    expect(
      book.adjudicate({ total: 6, raw: 2 }, { kind: 'check', target: 7, difficulty: 'normal' }),
    ).toEqual({
      outcome: 'fail',
      grade: 'normal',
    });
  });

  it('顺序即优先级：同骰值命中多条档表时取在前者（档表命中顺序红线）', () => {
    const book = new GenericRuleBook(
      config({
        grades: [
          { name: 'critical', when: 'total>=10' },
          { name: 'fumble', when: 'total>=10' },
        ],
      }),
    );
    expect(
      book.adjudicate({ total: 10, raw: 5 }, { kind: 'check', target: 7, difficulty: 'normal' })
        .outcome,
    ).toBe('critical');
  });
});

describe('adjudicateOpposed（比 total，平局三口径）', () => {
  const sides = { a: { roll: 8, skill: 0 }, b: { roll: 6, skill: 0 } };

  it('total 高者胜，与口径无关', () => {
    for (const tie of ['attacker', 'defender', 'tie'] as const) {
      expect(
        new GenericRuleBook(config({ opposedTie: tie })).adjudicateOpposed(sides.a, sides.b),
      ).toEqual({
        winner: 'a',
      });
      expect(
        new GenericRuleBook(config({ opposedTie: tie })).adjudicateOpposed(sides.b, sides.a),
      ).toEqual({
        winner: 'b',
      });
    }
  });

  it('平局三口径：attacker / defender / tie', () => {
    const a = { roll: 7, skill: 0 };
    const b = { roll: 7, skill: 0 };
    expect(new GenericRuleBook(config({ opposedTie: 'attacker' })).adjudicateOpposed(a, b)).toEqual(
      { winner: 'a' },
    );
    expect(new GenericRuleBook(config({ opposedTie: 'defender' })).adjudicateOpposed(a, b)).toEqual(
      { winner: 'b' },
    );
    expect(new GenericRuleBook(config({ opposedTie: 'tie' })).adjudicateOpposed(a, b)).toEqual({
      winner: 'tie',
    });
  });
});

describe('接口同构（与 coc7/dnd5e 的判定语义与审计流水对齐）', () => {
  it('无 sanityRule 能力（sanityRule 恒 false，空实现）', () => {
    const book: RuleBook = new GenericRuleBook(config());
    expect(book.sanityRule).toBeUndefined();
  });

  it('工厂：缺配置抛错；带配置可用；标识归一认 generic', () => {
    expect(() => createRuleBook('generic')).toThrow(RangeError);
    const book = createRuleBook('generic', { genericRule: config() });
    expect(book.id).toBe('generic');
    expect(book.genericConfig).toEqual(config());
    expect(ruleBookIdOf('generic')).toBe('generic');
    expect(ruleBookIdOf('unknown')).toBe('coc7');
  });

  it('审计快照可复现：同骰值 + 同档表重算出同一 outcome（audit-replay 契约）', () => {
    const grades = [
      { name: 'critical' as const, when: 'total>=10' },
      { name: 'fumble' as const, when: 'total<=3' },
    ];
    const book = createRuleBook('generic', { genericRule: config({ grades }) });
    const result = book.adjudicate(
      { total: 11, raw: 6 },
      { kind: 'check', target: 7, difficulty: 'normal', op: '>=' },
    );
    // 复现器按记录快照重建配置（骰式占位即可），重算必须一致
    const replay = new GenericRuleBook(
      GenericRuleSchema.parse({ dice: '1d20', grades }),
    ).adjudicate(
      { total: 11, raw: 6 },
      { kind: 'check', target: 7, difficulty: 'normal', op: '>=' },
    );
    expect(replay).toEqual(result);
  });
});

describe('genericQuickRef（S1 规则速查，随配置生成）', () => {
  it('含骰型/方向/种类/档表/平局口径与 dc 提示', () => {
    const ref = genericQuickRef(
      config({
        dice: '2d6',
        grades: [{ name: 'critical', when: 'total>=10' }],
        opposedTie: 'attacker',
      }),
    );
    expect(ref).toContain('2d6');
    expect(ref).toContain('check');
    expect(ref).toContain('total>=10 → critical');
    expect(ref).toContain('平局进攻方胜');
    expect(ref).toContain('dc');
  });
});
