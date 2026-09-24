import { APP_NAME, PROTOCOL_VERSION } from '@behindveil/shared';

/**
 * 前端外壳（骨架占位）。
 * M0 起替换为 Vue 3 + Pinia 组件树（player / kp-console 两视图，TDD §1.2）。
 */
export function renderShell(): string {
  return `<h1>${APP_NAME}</h1><p>protocol ${PROTOCOL_VERSION}</p>`;
}
