import { describe, expect, it } from 'vitest';
import { APP_NAME, MESSAGE_TYPES, PROTOCOL_VERSION } from './index.js';
import type { MessageType } from './index.js';

describe('shared contract placeholders', () => {
  it('exposes a stable app name', () => {
    expect(APP_NAME).toBe('BehindVeil');
  });

  it('exposes a semver-shaped protocol version', () => {
    expect(PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('defines exactly the six message types from TDD §3.2', () => {
    expect(MESSAGE_TYPES).toEqual(['ic', 'ooc', 'system', 'dice', 'narration', 'state_snapshot']);
  });

  it('keeps the runtime constant and the type in sync', () => {
    const all: MessageType[] = [...MESSAGE_TYPES];
    expect(new Set(all).size).toBe(MESSAGE_TYPES.length);
  });
});
