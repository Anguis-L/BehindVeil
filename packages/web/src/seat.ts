/**
 * 座席凭据存取（2026-10-07 GUI 真人调试修复）。
 *
 * 页面刷新会丢掉内存里的身份，用户重进即产生重复成员——服务端按 memberId 复用
 * 座席的语义早已存在（room:join 断线重连口径），缺的只是客户端持久化。
 * 落点只选 sessionStorage（关标签页即失效）——与 admin-token.ts 同一口径：
 * 房间常在多人共用设备上开着，localStorage 会长期留存。
 * hostToken 仅 Host 持有、转让后轮换失效；其泄露面与服务端口径一致
 * （memberId 与 hostToken 同为客户端持有凭据），不写日志、不随请求体回传。
 */

export const SEAT_KEY = 'bv.seat';

export interface StoredSeat {
  inviteCode: string;
  memberId: string;
  name: string;
  /** 仅 Host 持有（hostAuth='token' 口径下重连回收 Host 身份用）；玩家为空串 */
  hostToken: string;
}

/** SSR / 单测环境下没有 sessionStorage：静默降级为「没有座席」 */
function sessionBox(): Storage | null {
  return typeof sessionStorage === 'undefined' ? null : sessionStorage;
}

export function readSeat(): StoredSeat | null {
  const raw = sessionBox()?.getItem(SEAT_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const inviteCode = parsed['inviteCode'];
    const memberId = parsed['memberId'];
    const name = parsed['name'];
    const hostToken = parsed['hostToken'];
    if (
      typeof inviteCode !== 'string' ||
      typeof memberId !== 'string' ||
      typeof name !== 'string' ||
      typeof hostToken !== 'string'
    ) {
      return null;
    }
    return { inviteCode, memberId, name, hostToken };
  } catch {
    return null;
  }
}

export function writeSeat(seat: StoredSeat): void {
  const box = sessionBox();
  if (!box) return;
  box.setItem(SEAT_KEY, JSON.stringify(seat));
}

export function clearSeat(): void {
  sessionBox()?.removeItem(SEAT_KEY);
}
