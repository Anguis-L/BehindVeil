/**
 * 共享契约层入口。
 *
 * 当前为工程骨架占位，仅暴露跨端共用的常量与枚举。
 * M0「契约先行」阶段将按 TDD §3 / §4 补齐：
 *   message.ts / protocol.ts / worldbook.ts / dice.ts / module.ts
 */

export const APP_NAME = 'BehindVeil';

/** 前后端协议版本，握手时校验，不一致即拒绝连接 */
export const PROTOCOL_VERSION = '0.0.0';

/** 消息类型枚举（TDD §3.2 六类），运行时与类型共用同一来源 */
export const MESSAGE_TYPES = [
  'ic',
  'ooc',
  'system',
  'dice',
  'narration',
  'state_snapshot',
] as const;

export type MessageType = (typeof MESSAGE_TYPES)[number];
