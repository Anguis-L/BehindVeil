import { z } from 'zod';

/**
 * 错误码常量表（TDD §11）。
 *
 * 错误码是跨端契约：服务端按码记录系统行为，前端按码渲染用户侧文案。
 * `userMessage` 与 TDD §11「用户侧表现」列对齐，统一中文。
 */
export const ERROR_CODES = [
  'E-LLM-01',
  'E-LLM-02',
  'E-DICE-01',
  'E-AI-01',
  'E-ST-01',
  'E-ROOM-01',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorDetail {
  /** 触发场景（TDD §11「场景」列） */
  scene: string;
  /** 用户侧提示（TDD §11「用户侧表现」列）；E-AI-01 对玩家无感，故为空串 */
  userMessage: string;
}

export const ERROR_DETAILS: Record<ErrorCode, ErrorDetail> = {
  'E-LLM-01': { scene: 'provider 超时/5xx', userMessage: 'KP 沉吟中…（重试）' },
  'E-LLM-02': { scene: '流中断', userMessage: '生成中断，已保留已生成部分' },
  'E-DICE-01': { scene: '骰式非法', userMessage: '骰式无法解析' },
  'E-AI-01': { scene: 'AI 指令解析失败', userMessage: '' },
  'E-ST-01': { scene: '状态板版本冲突', userMessage: '数据已更新，请刷新' },
  'E-ROOM-01': { scene: '邀请码无效/满员', userMessage: '邀请码无效或房间已满' },
};

/** `error:app` 事件 / REST 错误响应的统一载荷（TDD §4.2） */
export const AppErrorSchema = z.object({
  code: z.enum(ERROR_CODES),
  message: z.string(),
});
export type AppError = z.infer<typeof AppErrorSchema>;
