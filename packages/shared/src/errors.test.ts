import { describe, expect, it } from 'vitest';
import { AppErrorSchema, ERROR_CODES } from './errors.js';

/**
 * T-M0-02：错误码常量表（TDD §11）。
 * 错误码是 `error:app` 事件的载荷契约（§4.2），前后端共用同一张表。
 */

describe('错误码常量表（TDD §11）', () => {
  it('恰好包含 TDD §11 定义的六个错误码', () => {
    expect([...ERROR_CODES].sort()).toEqual(
      ['E-AI-01', 'E-DICE-01', 'E-LLM-01', 'E-LLM-02', 'E-ROOM-01', 'E-ST-01'].sort(),
    );
  });

  it('每个错误码形如 E-<域>-<两位序号>', () => {
    for (const code of ERROR_CODES) {
      expect(code).toMatch(/^E-[A-Z]+-\d{2}$/);
    }
  });

  it('无重复项（常量表可作为枚举来源）', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });
});

describe('AppErrorSchema（error:app 载荷）', () => {
  it('接受 code + message 的合法载荷', () => {
    const parsed = AppErrorSchema.parse({ code: 'E-LLM-01', message: 'KP 沉吟中…（重试）' });
    expect(parsed).toEqual({ code: 'E-LLM-01', message: 'KP 沉吟中…（重试）' });
  });

  it('拒绝表外错误码（防止随意造码）', () => {
    expect(AppErrorSchema.safeParse({ code: 'E-FOO-99', message: 'x' }).success).toBe(false);
  });

  it('拒绝缺少 message 的载荷（错误必须可解释给用户）', () => {
    expect(AppErrorSchema.safeParse({ code: 'E-DICE-01' }).success).toBe(false);
  });

  it('六个错误码全部可被载荷 Schema 接受', () => {
    for (const code of ERROR_CODES) {
      expect(AppErrorSchema.safeParse({ code, message: '占位文案' }).success).toBe(true);
    }
  });
});
