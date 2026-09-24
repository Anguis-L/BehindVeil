import { describe, expect, it } from 'vitest';
import { APP_NAME, PROTOCOL_VERSION } from '@behindveil/shared';
import { renderShell } from './app.js';

describe('web shell', () => {
  it('renders the app name and protocol version', () => {
    const html = renderShell();
    expect(html).toContain(APP_NAME);
    expect(html).toContain(PROTOCOL_VERSION);
  });
});
