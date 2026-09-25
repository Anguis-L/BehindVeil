import { describe, expect, it } from 'vitest';
import { AppErrorSchema, ERROR_CODES } from './errors.js';

/**
 * T-M0-02：错误码常量表（TDD §11）。
 * 错误码是 `error:app` 事件的载荷契约（§4.2），前后端共用同一张表。
 */

describe('错误码常量表（TDD §11）', () => {
  /** TDD §11 的六个基础码；决议允许扩展（2026-09-25 拍板新增 E-MOD-01，见契约文档 §8） */
  const BASE_CODES = ['E-AI-01', 'E-DICE-01', 'E-LLM-01', 'E-LLM-02', 'E-ROOM-01', 'E-ST-01'];

  it('包含 TDD §11 定义的六个基础错误码', () => {
    for (const code of BASE_CODES) {
      expect(ERROR_CODES).toContain(code);
    }
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

const hasModCode = (ERROR_CODES as readonly string[]).includes('E-MOD-01');

describe.skipIf(!hasModCode)('E-MOD-01（决议：模组卸载冲突，2026-09-25 拍板）', () => {
  it('已入错误码表且可过 AppErrorSchema（D-09：活跃会话引用中拒绝卸载）', () => {
    expect(
      AppErrorSchema.safeParse({ code: 'E-MOD-01', message: '模组正被活跃会话使用，无法卸载' })
        .success,
    ).toBe(true);
  });
});
