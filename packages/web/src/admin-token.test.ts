import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_TOKEN_KEY, readAdminToken, writeAdminToken } from './admin-token.js';

/**
 * T-M6-04/05：管理令牌只存 sessionStorage（不落 localStorage）。
 * 用假 Storage 顶掉全局，顺带钉住「不碰 localStorage」这条约束。
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

beforeEach(() => {
  box = fakeBox();
  localBox = fakeBox();
  vi.stubGlobal('sessionStorage', box);
  vi.stubGlobal('localStorage', localBox);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('管理令牌存取', () => {
  it('未填过 → 空串', () => {
    expect(readAdminToken()).toBe('');
  });

  it('写入后可读回（去空白）', () => {
    writeAdminToken('  tok-123  ');
    expect(readAdminToken()).toBe('tok-123');
    expect(box.getItem(ADMIN_TOKEN_KEY)).toBe('tok-123');
  });

  it('空串＝清除', () => {
    writeAdminToken('tok-123');
    writeAdminToken('   ');
    expect(readAdminToken()).toBe('');
    expect(box.getItem(ADMIN_TOKEN_KEY)).toBeNull();
  });

  it('绝不落 localStorage', () => {
    writeAdminToken('tok-123');
    expect(localBox.length).toBe(0);
    expect(localBox.getItem(ADMIN_TOKEN_KEY)).toBeNull();
  });

  it('无 sessionStorage 环境（SSR/测试）不抛错', () => {
    vi.stubGlobal('sessionStorage', undefined);
    expect(readAdminToken()).toBe('');
    expect(() => writeAdminToken('tok')).not.toThrow();
  });
});
