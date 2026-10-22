import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEAT_KEY, clearSeat, readSeat, writeSeat, type StoredSeat } from './seat.js';

/**
 * 座席凭据存取（2026-10-07 GUI 真人调试修复）：memberId/hostToken 只存
 * sessionStorage（不落 localStorage），照 T-M6-04/05 管理令牌的同一口径。
 * 用假 Storage 顶掉全局，顺带钉住「不碰 localStorage」与残据容忍两条约束。
 */

function fakeBox(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  } as Storage;
}

let box: Storage;
let localBox: Storage;

const seat: StoredSeat = {
  inviteCode: 'ABC123',
  memberId: 'm-1',
  name: '阿灯',
  hostToken: 'h-1',
};

beforeEach(() => {
  box = fakeBox();
  localBox = fakeBox();
  vi.stubGlobal('sessionStorage', box);
  vi.stubGlobal('localStorage', localBox);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('座席凭据存取', () => {
  it('未填过 → null（不进房者无凭可恢复）', () => {
    expect(readSeat()).toBeNull();
  });

  it('写入后可完整读回（含 memberId —— 复位的关键）', () => {
    writeSeat(seat);
    expect(readSeat()).toEqual(seat);
    expect(box.getItem(SEAT_KEY)).toBe(JSON.stringify(seat));
  });

  it('玩家座席 hostToken 为空串也能读回（不因缺字段丢整个座席）', () => {
    writeSeat({ ...seat, hostToken: '' });
    expect(readSeat()).toEqual({ ...seat, hostToken: '' });
  });

  it('clearSeat 清残据，之后读回 null', () => {
    writeSeat(seat);
    clearSeat();
    expect(readSeat()).toBeNull();
    expect(box.getItem(SEAT_KEY)).toBeNull();
  });

  it('残据损坏（非法 JSON）→ null，不抛错', () => {
    box.setItem(SEAT_KEY, '{ not json');
    expect(readSeat()).toBeNull();
  });

  it('字段缺失/类型不对 → null（逐字段校验，不做部分恢复）', () => {
    // 少 memberId：恢复不了身份就没意义，必须整体作废而不是拿残缺数据进房
    box.setItem(SEAT_KEY, JSON.stringify({ inviteCode: 'ABC123', name: '阿灯', hostToken: '' }));
    expect(readSeat()).toBeNull();

    box.setItem(SEAT_KEY, JSON.stringify({ ...seat, memberId: 123 }));
    expect(readSeat()).toBeNull();

    box.setItem(SEAT_KEY, JSON.stringify({ ...seat, name: null }));
    expect(readSeat()).toBeNull();
  });

  it('绝不落 localStorage', () => {
    writeSeat(seat);
    expect(localBox.length).toBe(0);
    expect(localBox.getItem(SEAT_KEY)).toBeNull();
  });

  it('无 sessionStorage 环境（SSR/测试）不抛错', () => {
    vi.stubGlobal('sessionStorage', undefined);
    expect(readSeat()).toBeNull();
    expect(() => writeSeat(seat)).not.toThrow();
    expect(() => clearSeat()).not.toThrow();
  });
});
