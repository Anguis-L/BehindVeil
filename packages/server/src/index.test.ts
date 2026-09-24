import { describe, expect, it } from 'vitest';
import { APP_NAME, PROTOCOL_VERSION } from '@behindveil/shared';
import { serverInfo } from './index.js';

describe('server assembly root', () => {
  it('derives its name from the shared contract', () => {
    expect(serverInfo.name).toBe(`${APP_NAME}-server`);
  });

  it('reports the same protocol version as the shared contract', () => {
    expect(serverInfo.protocol).toBe(PROTOCOL_VERSION);
  });
});
