/**
 * 管理令牌（X-Admin-Token）存取（T-M6-04/05）。
 *
 * 网页端拿不到管理面令牌，改由 KP 在控制台自己填一次。落点只选 sessionStorage
 * （关标签页即失效）——房间常在多人共用设备上开着，localStorage 会长期留存；
 * 令牌也不写日志、不随请求体回传，只进 `X-Admin-Token` 头。
 */

export const ADMIN_TOKEN_KEY = 'bv.adminToken';

/** SSR / 单测环境下没有 sessionStorage：静默降级为「没有令牌」 */
function sessionBox(): Storage | null {
  return typeof sessionStorage === 'undefined' ? null : sessionStorage;
}

export function readAdminToken(): string {
  return sessionBox()?.getItem(ADMIN_TOKEN_KEY) ?? '';
}

/** 空串等同清除 */
export function writeAdminToken(token: string): void {
  const box = sessionBox();
  if (!box) return;
  const trimmed = token.trim();
  if (trimmed === '') box.removeItem(ADMIN_TOKEN_KEY);
  else box.setItem(ADMIN_TOKEN_KEY, trimmed);
}
