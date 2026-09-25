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
  'E-MOD-01',
  'E-SRV-01',
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
  // 2026-09-25 拍板新增（决议 ③，D-09）：模组被活跃会话引用时拒绝卸载
  'E-MOD-01': { scene: '模组卸载冲突', userMessage: '模组使用中，无法卸载' },
  // 2026-09-25 拍板新增：服务端内部错误（TC-FR-02-001 故障变体——WAP 链路写盘失败时
  // 该消息不广播并回业务错误；也覆盖 dispatch 其他未预期失败）
  'E-SRV-01': { scene: '服务端持久化/内部错误', userMessage: '服务器开小差了，请稍后重试' },
};

/** `error:app` 事件 / REST 错误响应的统一载荷（TDD §4.2） */
export const AppErrorSchema = z.object({
  code: z.enum(ERROR_CODES),
  message: z.string(),
});
export type AppError = z.infer<typeof AppErrorSchema>;
