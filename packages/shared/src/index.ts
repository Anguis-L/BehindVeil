/**
 * 共享契约层入口（TDD §1.2：web → shared ← server）。
 *
 * M0「契约先行」交付：message.ts / dice.ts / domain.ts / errors.ts。
 * protocol.ts（Socket 事件契约）随 T-M1-04 落地；worldbook.ts 完整拆分随 T-M2-01；
 * module.ts 随 T-M5-05。
 */

export const APP_NAME = 'BehindVeil';

/** 前后端协议版本，握手时校验，不一致即拒绝连接 */
export const PROTOCOL_VERSION = '0.0.0';

export * from './errors.js';
export * from './dice.js';
export * from './domain.js';
export * from './message.js';
export * from './protocol.js';
