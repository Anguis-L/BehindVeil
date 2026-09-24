import {
  LlmError,
  type ChatRequest,
  type ChatResponse,
  type LlmAdapter,
} from '../../domain/llm.js';
import type { ErrorCode } from '@behindveil/shared';

/**
 * MockLlm（T-M0-10，TDD §10）：脚本化回放适配器。
 * 黄金用例、契约对拍（TC-FR-03-001）、无 key CI 全链路与 50 轮回归（T-M3-07）的
 * 确定性 LLM 替身。剧本为 JSON 可序列化步骤数组——YAML/JSON 剧本文件由测试侧
 * 加载后传入（测试文档 §2）。
 *
 * 消费模型：游标跨 chat 调用持续推进（一轮对话消费一段剧本，直至脚本尾或 error 步骤），
 * 支持「叙事 → 检定 → 续写」多调用回放；脚本耗尽后产出空 content（等同空脚本）。
 */
export type MockScriptStep =
  | {
      /** 发出一个增量 */
      delta: string;
    }
  | {
      /** 产出 aidle 指令块（FR-05 检定闭环用） */
      directive: Record<string, unknown>;
    }
  | {
      /** 注入业务错误：到此处中止本次调用并抛 LlmError */
      error: ErrorCode;
    };

export interface MockLlmOptions {
  /**
   * 指令块格式错误注入率 0..1（R-01 / 降级链 / F-04 畸形语料用）。
   * 命中时指令块 JSON 被确定性破坏（尾逗号），errorRate=1 恒为畸形。
   */
  errorRate?: number;
}

export interface MockLlmAdapter extends LlmAdapter {
  /** 每次调用的请求留痕（契约对拍与回归分析用） */
  readonly calls: ChatRequest[];
}

export function createMockLlm(
  options: MockLlmOptions & { script?: MockScriptStep[] } = {},
): MockLlmAdapter {
  return new MockLlmAdapterImpl(options.script ?? [], options.errorRate ?? 0);
}

class MockLlmAdapterImpl implements MockLlmAdapter {
  readonly id = 'mock';
  readonly calls: ChatRequest[] = [];

  private cursor = 0;

  constructor(
    private readonly script: MockScriptStep[],
    private readonly errorRate: number,
  ) {}

  async chat(req: ChatRequest, onDelta: (delta: string) => void): Promise<ChatResponse> {
    this.calls.push(req);
    let content = '';
    while (this.cursor < this.script.length) {
      const step = this.script[this.cursor];
      this.cursor += 1;
      if (!step) break;
      if ('error' in step)
        throw new LlmError(step.error, `MockLlm 注入错误：${step.error}`, { retryable: false });
      if ('delta' in step) {
        onDelta(step.delta);
        content += step.delta;
        continue;
      }
      // directive 步骤：产出 aidle 栅栏块（2 空格缩进，与测试断言格式一致）
      let json = JSON.stringify(step.directive, null, 2);
      if (this.errorRate > 0 && Math.random() < this.errorRate) {
        json = `${json.slice(0, -1)},}`; // 确定性破坏：尾逗号（F-04 语料形态之一）
      }
      const block = `\`\`\`aidle\n${json}\n\`\`\``;
      onDelta(block);
      content += block;
    }
    return { content, finishReason: 'stop', aborted: false };
  }
}
