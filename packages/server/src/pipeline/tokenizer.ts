/**
 * Tokenizer 接口（T-M0-06，TDD §5.1 buildPrompt 注入点）。
 *
 * v1 采用启发式估算（决议 D-06）：CJK ≈ 1 字/token、ASCII ≈ 4 字符/token、
 * 其余非 ASCII 字符（符号/emoji 等）按 1 token 计。各段向上取整——估算宁高勿低，
 * 系统性低估会导致 S4 预算失守（TC-FR-07-017）。接口注入，后续可换精确实现。
 */
export interface Tokenizer {
  count(text: string): number;
}

export function createHeuristicTokenizer(): Tokenizer {
  return {
    count(text: string): number {
      let ascii = 0;
      let cjk = 0;
      let other = 0;
      for (const ch of text) {
        const cp = ch.codePointAt(0);
        if (cp === undefined) {
          other += 1;
          continue;
        }
        if (cp < 0x80) {
          ascii += 1;
        } else if (isCjk(cp)) {
          cjk += 1;
        } else {
          other += 1;
        }
      }
      return Math.ceil(ascii / 4) + cjk + other;
    },
  };
}

function isCjk(cp: number): boolean {
  return (
    (cp >= 0x3000 && cp <= 0x303f) || // CJK 符号与标点（。、「」……）
    (cp >= 0x3040 && cp <= 0x30ff) || // 平假名 / 片假名
    (cp >= 0x3400 && cp <= 0x4dbf) || // 表意文字扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 统一表意文字
    (cp >= 0xac00 && cp <= 0xd7af) || // 谚文音节
    (cp >= 0xf900 && cp <= 0xfaff) || // 兼容表意文字
    (cp >= 0xff00 && cp <= 0xffef) || // 全角形式（！＂＃……）
    cp >= 0x20000 // 表意文字扩展 B 起（平面 2+）
  );
}
