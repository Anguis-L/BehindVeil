import { APP_NAME, PROTOCOL_VERSION } from '@behindveil/shared';

/**
 * 服务端组装根（骨架占位）。
 *
 * 实际结构将在对应里程碑落地，见 TDD §1.2：
 *   gateway/  domain/  pipeline/  adapters/  observability/
 * 唯一不变式：叙事交给 LLM，规则交给代码——任何掷骰都在此进程内用 CSPRNG 完成。
 */
export const serverInfo = {
  name: `${APP_NAME}-server`,
  protocol: PROTOCOL_VERSION,
} as const;
