import type { WorldBook, WorldBookEntry } from '@behindveil/shared';

/**
 * 世界书扫描引擎（T-M2-02，TDD §5.2）。
 *
 * 输入是已按 scanDepth 切好的消息文本（切片归管线 S3，本模块只管匹配语义）：
 * 子串匹配 + `/regex/` 形式（非法正则降级为字面量并告警，不崩溃）、
 * 四种 selectiveLogic、空 secondary 视为无二级键、constant/kpOnly 恒命中、
 * 递归默认 1 层——命中条目 content 参与下一轮扫描，按 uid 去重防循环。
 * 复杂度 O(条目数 × 关键词数 × 文本长度)，NFR-05：<50ms@500 条目。
 */

export interface ScanHit {
  entry: WorldBookEntry;
  /** 命中的主关键词（原样返回；constant/kpOnly 恒命中时为空数组） */
  matchedKeys: string[];
  /** 命中的二级关键词（进 trace 供 KP 预览） */
  matchedSecondary: string[];
}

export interface ScanOptions {
  /** 递归轮数：命中条目 content 并入扫描文本再扫（默认 1） */
  recursionDepth?: number;
}

export function scanWorldBook(texts: string[], book: WorldBook, opts: ScanOptions = {}): ScanHit[] {
  const depth = opts.recursionDepth ?? 1;
  const hits = new Map<number, ScanHit>();
  let corpus = texts.join('\n');

  for (let round = 0; round <= depth; round += 1) {
    const fresh: ScanHit[] = [];
    for (const entry of book.entries) {
      if (entry.disabled || hits.has(entry.uid)) continue;
      const hit = evaluateEntry(entry, corpus);
      if (hit) {
        hits.set(entry.uid, hit);
        fresh.push(hit);
      }
    }
    if (fresh.length === 0) break;
    corpus = `${corpus}\n${fresh.map((h) => h.entry.content).join('\n')}`;
  }

  return [...hits.values()];
}

function evaluateEntry(entry: WorldBookEntry, corpus: string): ScanHit | null {
  // 常驻条目与 kpOnly 条目（模组真相）恒命中（TDD §5.1 S3：kpOnly 永远注入）
  if (entry.constant || entry.extensions?.kpOnly === true) {
    return { entry, matchedKeys: [], matchedSecondary: [] };
  }

  const matchedKeys = entry.key.filter((keyword) => matchKeyword(keyword, corpus));
  if (matchedKeys.length === 0) return null;

  // 空 keysecondary：primary 命中即命中（TC-FR-07-004）
  if (entry.keysecondary.length === 0) {
    return { entry, matchedKeys, matchedSecondary: [] };
  }

  const matchedSecondary = entry.keysecondary.filter((keyword) => matchKeyword(keyword, corpus));
  const all: ScanHit = { entry, matchedKeys, matchedSecondary };
  switch (entry.selectiveLogic) {
    case 0: // AND_ANY：primary 命中且 secondary 任一命中
      return matchedSecondary.length > 0 ? all : null;
    case 1: // NOT_ALL：primary 命中且 secondary 非全命中
      return matchedSecondary.length < entry.keysecondary.length ? all : null;
    case 2: // NOT_ANY：primary 命中且 secondary 零命中
      return matchedSecondary.length === 0 ? all : null;
    case 3: // AND_ALL：primary 命中且 secondary 全命中
      return matchedSecondary.length === entry.keysecondary.length ? all : null;
  }
}

/** 关键词匹配：`/regex/` 形式走正则，其余子串包含（均大小写敏感，确定性优先） */
function matchKeyword(keyword: string, corpus: string): boolean {
  if (keyword.length > 2 && keyword.startsWith('/') && keyword.endsWith('/')) {
    try {
      return new RegExp(keyword.slice(1, -1)).test(corpus);
    } catch {
      // 非法正则降级为字面量匹配（TC-FR-07-003），不崩溃
      console.warn(`[worldbook] 非法正则关键词，已降级为字面量匹配：${keyword}`);
    }
  }
  return corpus.includes(keyword);
}
