import { repairJson } from './repair.js';
import type { CheckDirective } from './schema.js';
import { validateDirective } from './validate.js';

/**
 * 扫描事件（T-M3-01/02，TDD §5.4 处理循环）。
 *
 * 四类事件覆盖 R-01 成功率口径（测试文档 §12.4）的全部计数项：
 * `directive`（成功）/ `parse-error`（解析失败）/ `rejected`（白名单拒绝）三者相除得成功率，
 * `truncated`（截断流丢弃）不计入分母——开栅栏未闭合不构成一次完整解析尝试。
 * `block` 为该块在本流中的序号（0 起，含截断块）；`start`/`end` 是块在全流中的
 * 绝对字符区间 [start, end)（end 仅闭合块有），供闭环编排器从叙事全文剥离指令块。
 */
export type DirectiveScanEvent =
  | { kind: 'directive'; block: number; directive: CheckDirective; start: number; end: number }
  | {
      kind: 'parse-error';
      block: number;
      code: 'E-AI-01';
      reason: string;
      /** 块内容原始文本（栅栏之间，供 data/logs/ 失败留档，测试文档 §12.4） */
      raw: string;
      start: number;
      end: number;
    }
  | {
      kind: 'rejected';
      block: number;
      code: 'E-AI-01';
      reason: string;
      raw: string;
      start: number;
      end: number;
    }
  | { kind: 'truncated'; block: number; start: number };

/**
 * 开栅栏：行首（允许缩进）```aidle，后接行尾或空白——```aidlefoo 不算。
 * 闭合栅栏：整行 trim 后恰为 ```。块内容取两栅栏之间的行。
 */
const OPEN_FENCE_RE = /^```aidle(?=\s|$)/;

/**
 * AI 指令块流式扫描器（T-M3-01，TDD §5.4）。
 *
 * 逐行状态机：idle 下遇开栅栏进 inBlock，缓冲至闭合栅栏 → 容错修复 + JSON 解析
 * → op 白名单校验 → 产出事件。按行缓冲天然处理跨 delta 的栅栏/JSON 切分：
 * 未完结的行留在缓冲，不误触发（TC-FR-05-003「按策略缓冲」）。
 *
 * 截断流策略（TC-FR-05-003）：流结束（flush）时仍未闭合的块整体丢弃，
 * 产 truncated 事件供 KP 端留痕，绝不当作指令执行。
 *
 * 用法：narration 每个 delta 依次 feed()，流结束调 flush()；两方法各自返回
 * 本次新增事件（按序）。同一流内连续多指令块按序全部产出（TC-FR-05-004）。
 */
export class DirectiveStreamScanner {
  private buf = '';
  /** buf[0] 在全流中的绝对偏移 */
  private base = 0;
  private inBlock = false;
  private blockStart = 0;
  private blockLines: string[] = [];
  private blockIndex = 0;
  private currentBlock = 0;

  feed(delta: string): DirectiveScanEvent[] {
    this.buf += delta;
    return this.consume(false);
  }

  flush(): DirectiveScanEvent[] {
    const events = this.consume(true);
    if (this.inBlock) {
      this.inBlock = false;
      this.blockLines = [];
      events.push({ kind: 'truncated', block: this.currentBlock, start: this.blockStart });
    }
    return events;
  }

  /**
   * 当前是否处于未闭合指令块内（闭环编排器消费）：块内增量不得广播给前端，
   * 编排器据此做流式剥离（scan 事件只带块区间，开栅栏行完成时无事件，须查此状态）。
   */
  get isInBlock(): boolean {
    return this.inBlock;
  }

  private consume(final: boolean): DirectiveScanEvent[] {
    const events: DirectiveScanEvent[] = [];
    for (;;) {
      const nl = this.buf.indexOf('\n');
      if (nl === -1) {
        if (!final || this.buf.length === 0) break;
        // flush 收尾：处理无换行符的末行，随后清空缓冲（scanner 终态）
        const line = this.buf;
        const lineStart = this.base;
        this.buf = '';
        this.base += line.length;
        return events.concat(this.processLine(line, lineStart)).concat(this.drainTruncated());
      }
      const line = this.buf.slice(0, nl);
      const lineStart = this.base;
      this.buf = this.buf.slice(nl + 1);
      this.base += nl + 1;
      events.push(...this.processLine(line, lineStart));
    }
    return events;
  }

  /** flush 专用：末行处理完后若仍在块中 → 截断丢弃 */
  private drainTruncated(): DirectiveScanEvent[] {
    if (!this.inBlock) return [];
    this.inBlock = false;
    this.blockLines = [];
    return [{ kind: 'truncated', block: this.currentBlock, start: this.blockStart }];
  }

  private processLine(line: string, lineStart: number): DirectiveScanEvent[] {
    const trimmed = line.trim();

    if (!this.inBlock) {
      const fenceAt = line.indexOf('```aidle');
      if (fenceAt !== -1 && OPEN_FENCE_RE.test(trimmed)) {
        this.inBlock = true;
        this.blockStart = lineStart + fenceAt;
        this.currentBlock = this.blockIndex;
        this.blockIndex += 1;
        // 开栅栏行内 ````aidle` 之后的内容按块首行处理（CommonMark 语义）；纯空白不算
        const remainder = line.slice(fenceAt + '```aidle'.length);
        if (remainder.trim() !== '') this.blockLines.push(remainder);
      }
      return [];
    }

    if (trimmed === '```') {
      this.inBlock = false;
      const fenceAt = line.indexOf('```');
      const end = lineStart + fenceAt + '```'.length;
      const block = this.currentBlock;
      return [this.finishBlock(block, end)];
    }

    this.blockLines.push(line);
    return [];
  }

  private finishBlock(block: number, end: number): DirectiveScanEvent {
    const raw = this.blockLines.join('\n');
    this.blockLines = [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(repairJson(raw));
    } catch (err) {
      // JSON.parse 契约只抛 Error（SyntaxError），显式窄化即可
      return {
        kind: 'parse-error',
        block,
        code: 'E-AI-01',
        reason: (err as Error).message,
        raw,
        start: this.blockStart,
        end,
      };
    }

    const verdict = validateDirective(parsed);
    if (verdict.ok) {
      return {
        kind: 'directive',
        block,
        directive: verdict.directive,
        start: this.blockStart,
        end,
      };
    }
    return {
      kind: 'rejected',
      block,
      code: 'E-AI-01',
      reason: verdict.reason,
      raw,
      start: this.blockStart,
      end,
    };
  }
}
