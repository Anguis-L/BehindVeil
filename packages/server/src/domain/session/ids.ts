import { nanoid, customAlphabet } from 'nanoid';

/**
 * 标识符生成（T-M1-01，TDD §3.1）。
 * 全部基于 nanoid 的 crypto CSPRNG——邀请码/令牌与掷骰同源，无用户可控种子路径（NFR-04）。
 * 邀请码字母表剔除 I/O/0/1 等易混淆字符（口播/手抄友好）。
 */

const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateRoomId(): string {
  return nanoid(12);
}

export function generateInviteCode(): string {
  return customAlphabet(INVITE_ALPHABET, 6)();
}

export function generateMemberId(): string {
  return `m_${nanoid(10)}`;
}

export function generateSessionId(): string {
  return `s_${nanoid(10)}`;
}

/** Host 身份凭据（开放问题①默认方案）：仅返回给建房者，任何列表/详情响应都不得外带 */
export function generateHostToken(): string {
  return nanoid(32);
}
