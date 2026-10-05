import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDataLayout } from '../adapters/storage/layout.js';
import { rebuildGlobalIndex } from '../observability/global-index.js';

/**
 * aidle-reindex：跨房间全局索引全量重建（v3 T-M11-05，FR-34）。
 *
 * 索引是派生数据（损坏即弃），重建路径是「读全部消息文件 → 重放索引行」：
 * 1. 删掉旧 `data/index/global.jsonl`（先删后写，避免旧行残留造成重复命中）；
 * 2. 逐房间逐会话读 messages.jsonl，过 MessageSchema 重放；
 * 3. 报告条目数与坏行数——坏行来自消息文件本身的损坏，重建**不修复**消息，
 *    只如实报告（修消息是恢复器/迁移器的辖区，不在此处静默代劳）。
 *
 * 退出码：0 = 重建完成（坏行只告警）；1 = 不可恢复的 IO 失败。
 * 用法：node packages/server/dist/cli/aidle-reindex.js [dataDir]
 */

export interface ReindexResult {
  readonly entries: number;
  readonly badLines: number;
  readonly lines: readonly string[];
}

export async function runReindex(dataDir: string): Promise<ReindexResult> {
  const layout = createDataLayout(dataDir);
  const file = layout.globalIndexFile;

  // 清空旧索引由 rebuildGlobalIndex 负责（重建自带幂等），CLI 只管报告
  const { entries, badLines } = await rebuildGlobalIndex(dataDir);

  const lines = [
    `已重建全局索引：${file}`,
    `索引条目 ${entries} 条` +
      (badLines > 0 ? `，消息坏行 ${badLines} 条（索引跳过，请检查对应 messages.jsonl）` : ''),
  ];
  return { entries, badLines, lines };
}

async function main(): Promise<void> {
  const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const dataDir = resolve(arg ?? 'data');
  try {
    const result = await runReindex(dataDir);
    process.stdout.write(`${result.lines.join('\n')}\n`);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
