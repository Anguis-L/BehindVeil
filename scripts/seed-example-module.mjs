#!/usr/bin/env node
/**
 * 示例模组种子脚本（T-M9-01）：把 examples/modules/ 下的示例模组复制到 data/modules/，
 * 让自托管部署开箱即跑（新房 → 装模组 → 开团，无需手工搬运文件）。
 *
 * 用法：
 *   node scripts/seed-example-module.mjs [--data-dir <路径>] [--force]
 *   --data-dir  指定运行时数据根目录（默认 <仓库根>/data；发布包部署后即默认值）
 *   --force     目标已存在时覆盖（默认跳过，不动用户已改过的内容）
 *
 * 幂等：目标已存在且无 --force 时跳过并提示；退出码 0 表示全部就位。
 */
import { access, cp, mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const examplesDir = join(repoRoot, 'examples', 'modules');

const args = process.argv.slice(2);
const dataDirFlag = args.indexOf('--data-dir');
const dataRoot = resolve(
  dataDirFlag !== -1 ? (args[dataDirFlag + 1] ?? '') : join(repoRoot, 'data'),
);
const force = args.includes('--force');

const modulesDir = join(dataRoot, 'modules');
await mkdir(modulesDir, { recursive: true });

const names = (await readdir(examplesDir)).filter((n) => !n.startsWith('.'));
let seeded = 0;
let skipped = 0;
for (const name of names) {
  const dest = join(modulesDir, name);
  const exists = await access(dest)
    .then(() => true)
    .catch(() => false);
  if (exists && !force) {
    console.warn(`[seed] 跳过（已存在）：${name}`);
    skipped += 1;
    continue;
  }
  await cp(join(examplesDir, name), dest, { recursive: true, force: true });
  console.warn(`[seed] 已就位：${name} → ${dest}`);
  seeded += 1;
}
console.warn(`[seed] 完成：${seeded} 个复制，${skipped} 个跳过（共 ${names.length} 个示例模组）`);
