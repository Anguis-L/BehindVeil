#!/usr/bin/env node
/**
 * 许可证门禁（TDD §10 / NFR-08）
 *
 * 扫描整棵依赖树，出现 AGPL / GPL 系许可证立即失败。
 * 本项目以 MIT 发布，引入传染性许可证会直接破坏自托管分发的合规性，
 * 因此这条门禁是硬性的，不允许用 continue-on-error 绕过。
 *
 * 实现说明：直接遍历 pnpm 的虚拟存储（node_modules/.pnpm）读取每个包的
 * package.json，不依赖子进程调用，因此在任何平台/受限环境下行为一致。
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const VIRTUAL_STORE = resolve(process.cwd(), 'node_modules/.pnpm');

/** 拒收的传染性许可证（NFR-08） */
const DENY_PATTERNS = [/\bAGPL\b/i, /\bGPL\b/i];

/** 需要人工确认的模糊许可证（仅告警，不阻断） */
const WARN_PATTERNS = [/^\s*$/, /^UNKNOWN$/i, /^UNLICENSED$/i, /^CUSTOM$/i, /^N\/A$/i];

function readPackageJson(dir) {
  const file = join(dir, 'package.json');
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return {
      name: raw.name ?? dir,
      version: raw.version ?? '',
      // 老包可能用 licenses 数组或 { type } 对象
      license: normalizeLicense(raw.license ?? raw.licenses),
    };
  } catch {
    return null;
  }
}

function normalizeLicense(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(normalizeLicense).filter(Boolean).join(' OR ');
  if (typeof value === 'object' && 'type' in value) return String(value.type);
  return '';
}

/**
 * pnpm 虚拟存储结构：
 *   node_modules/.pnpm/<name>@<version>/node_modules/<pkg>
 * 作用域包多一层 .pnpm/@scope+name@version/node_modules/@scope/name
 */
function collectPackages() {
  if (!existsSync(VIRTUAL_STORE)) {
    throw new Error(`未找到 ${VIRTUAL_STORE}，请先执行 pnpm install 再运行许可证门禁。`);
  }

  const found = new Map();

  for (const entry of readdirSync(VIRTUAL_STORE)) {
    if (entry === 'node_modules' || entry === 'lock.yaml' || entry.startsWith('.')) continue;

    const innerModules = join(VIRTUAL_STORE, entry, 'node_modules');
    if (!existsSync(innerModules)) continue;

    for (const inner of readdirSync(innerModules)) {
      const targets = inner.startsWith('@')
        ? readdirSync(join(innerModules, inner)).map((sub) => join(innerModules, inner, sub))
        : [join(innerModules, inner)];

      for (const target of targets) {
        if (!statSync(target, { throwIfNoEntry: false })?.isDirectory()) continue;
        const pkg = readPackageJson(target);
        if (pkg) found.set(`${pkg.name}@${pkg.version}`, pkg);
      }
    }
  }

  return [...found.values()];
}

function main() {
  const rows = collectPackages();

  const denied = [];
  const warned = [];

  for (const row of rows) {
    const label = row.license;
    if (DENY_PATTERNS.some((re) => re.test(label))) {
      denied.push(row);
    } else if (WARN_PATTERNS.some((re) => re.test(label))) {
      warned.push(row);
    }
  }

  if (warned.length > 0) {
    console.warn(`\n[license] 发现 ${warned.length} 个许可证不明的依赖，建议人工确认：`);
    for (const row of warned.slice(0, 20)) {
      console.warn(`  - ${row.name}@${row.version} → ${row.license || '(未声明)'}`);
    }
  }

  if (denied.length > 0) {
    console.error(`\n[license] 失败：发现 ${denied.length} 个 AGPL/GPL 系依赖（NFR-08 拒收）：`);
    for (const row of denied) {
      console.error(`  - ${row.name}@${row.version} → ${row.license}`);
    }
    console.error('\n请替换为宽松许可证（MIT / BSD / Apache-2.0 / ISC）的替代方案后再合入。');
    process.exit(1);
  }

  console.log(`[license] 通过：扫描 ${rows.length} 个依赖，无 AGPL/GPL。`);
}

try {
  main();
} catch (err) {
  console.error(`[license] 扫描失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
