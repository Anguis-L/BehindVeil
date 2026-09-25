/**
 * JSON 容错修复（T-M3-01，TDD §5.4「去注释/尾逗号修复」）。
 *
 * LLM 产出的指令 JSON 常见两类违规：`//` 与块注释（`/*` 开头）、尾逗号。
 * 修复必须字符串感知——注释符号与形如尾逗号的序列可能出现在字符串字面量内
 * （如 {"label": "翻查 // 书桌"}），盲目正则会误伤内容（TC-FR-05-002）。
 * 修复是尽力而为：不可修复的输入原样返回，由 JSON.parse 报 parse-error。
 */
export function repairJson(src: string): string {
  let out = '';
  let i = 0;
  let inString = false;

  while (i < src.length) {
    const ch = src[i] as string;

    if (inString) {
      out += ch;
      if (ch === '\\') {
        // 转义序列原样保留（含 \"，防止提前出串）
        if (i + 1 < src.length) out += src[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }

    // 行注释：吞到行尾（换行符本身保留）
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }

    // 块注释：吞到 */（未闭合则吞到末尾）
    if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i = Math.min(i + 2, src.length);
      continue;
    }

    // 尾逗号：后瞻跳过空白后为 } 或 ] 则丢弃
    if (ch === ',') {
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j] as string)) j += 1;
      if (src[j] === '}' || src[j] === ']') {
        i += 1;
        continue;
      }
    }

    out += ch;
    i += 1;
  }

  return out;
}
