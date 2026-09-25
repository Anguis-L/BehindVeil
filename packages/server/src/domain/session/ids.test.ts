import { describe, expect, it } from 'vitest';
import {
  generateHostToken,
  generateInviteCode,
  generateMemberId,
  generateRoomId,
  generateSessionId,
} from './ids.js';

/**
 * T-M1-01：标识符生成（TDD §3.1）。
 * 全部基于 nanoid 的 crypto CSPRNG（NFR-04）；形状约定是 HTTP/Socket 契约的一部分
 * （inviteCode 6 位、hostToken 高熵凭据），故逐一生成器断言长度与字母表。
 */

describe('标识符生成（T-M1-01）', () => {
  it('generateRoomId：12 位 nanoid', () => {
    expect(generateRoomId()).toMatch(/^[A-Za-z0-9_-]{12}$/);
  });

  it('generateInviteCode：6 位且落在无易混淆字符的字母表内', () => {
    const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (let i = 0; i < 50; i++) {
      const code = generateInviteCode();
      expect(code).toHaveLength(6);
      for (const ch of code) expect(ALPHABET).toContain(ch);
    }
  });

  it('generateMemberId / generateSessionId：带类型前缀', () => {
    expect(generateMemberId()).toMatch(/^m_[A-Za-z0-9_-]{10}$/);
    expect(generateSessionId()).toMatch(/^s_[A-Za-z0-9_-]{10}$/);
  });

  it('generateHostToken：32 位高熵凭据（仅随建房响应下发一次）', () => {
    expect(generateHostToken()).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it('批量生成唯一（CSPRNG，无用户可控种子）', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateRoomId()));
    expect(ids.size).toBe(100);
  });
});
