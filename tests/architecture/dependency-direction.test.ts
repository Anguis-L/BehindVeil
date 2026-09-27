import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * T-M0-01b：依赖方向守护（TDD §1.2）。
 *
 *   web → shared ← server
 *   domain 不 import gateway；pipeline 不 import adapters（通过接口注入）
 *
 * 说明：CI 的强制手段是 ESLint import 边界规则（T-M0-01b 主产出）；
 * 本用例是同一约束的可执行补充——它直接扫源码，不依赖 lint 配置是否生效。
 *
 * 2026-09-27 加固（原实现有三处漏检）：
 *   ① 逐行正则匹配不到多行 import（`import {\n A,\n} from './x'`）——改为全文正则，
 *      并把「相对路径」与「@behindveil/* 包名」一律解析成绝对路径再判定；
 *   ② 只认包名、不认相对路径——跨包写 `../../server/src/...` 可绕过，现一并拦下；
 *   ③ 文件无 import 时内层循环不执行、expect 不被调用 → 静默通过——改为先收集违规
 *      再统一断言，无论有无违规都恰好有一条断言，并额外断言「确实扫到了文件」。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PKG = (name: string): string => path.join(ROOT, 'packages', name);

async function sourceFiles(dir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return; // 目录尚未创建（里程碑未到），跳过
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        files.push(full);
      }
    }
  }

  await walk(dir);
  return files;
}

/**
 * 去掉注释。
 * 注释里写 `import x from 'gateway/y'` 会被误判成真实引用，必须先清掉；
 * 字符串字面量则**原样保留**——模块说明符本身就写在引号里，挖空它就抓不到引用了。
 * （顺带效果：字符串里的 `//`、`/*` 不会被误当注释起点。）
 */
function stripComments(code: string): string {
  let out = '';
  let i = 0;
  while (i < code.length) {
    const char = code[i];
    const next = code[i + 1];

    if (char === '/' && next === '/') {
      const end = code.indexOf('\n', i);
      i = end === -1 ? code.length : end;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = code.indexOf('*/', i + 2);
      i = end === -1 ? code.length : end + 2;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      // 整段原样拷贝，字符串内的 // 与 /* 不当注释处理
      let end = i + 1;
      while (end < code.length) {
        if (code[end] === '\\') {
          end += 2;
          continue;
        }
        if (code[end] === char) {
          end += 1;
          break;
        }
        end += 1;
      }
      out += code.slice(i, end);
      i = end;
      continue;
    }

    out += char;
    i += 1;
  }
  return out;
}

/**
 * 取模块说明符（解析为绝对路径）。
 * `[^;]*?` 保证一条 import/export 语句不会跨过 `;` 去咬住下一句。
 */
const FROM_RE = /\b(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/g;
const BARE_RE = /\bimport\s+['"]([^'"]+)['"]/g; // 副作用导入：import './polyfill.js'
const DYNAMIC_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g; // 动态 import()

function resolveSpecifier(spec: string, fromFile: string): string {
  if (spec.startsWith('.')) return path.resolve(path.dirname(fromFile), spec);

  // 包名指向包的源码根（运行时走 dist，但依赖方向约束的是源码）
  const scoped = /^@behindveil\/(shared|server|web)$/.exec(spec);
  if (scoped?.[1]) return path.join(PKG(scoped[1]), 'src');

  return path.join(ROOT, 'node_modules', spec); // 第三方：不可能命中禁区
}

function moduleSpecifiers(code: string, fromFile: string): string[] {
  const clean = stripComments(code);
  const specs: string[] = [];
  for (const re of [FROM_RE, BARE_RE, DYNAMIC_RE]) {
    for (const match of clean.matchAll(re)) {
      if (match[1]) specs.push(resolveSpecifier(match[1], fromFile));
    }
  }
  return specs;
}

function isUnder(target: string, dir: string): boolean {
  return target === dir || target.startsWith(dir + path.sep);
}

interface Rule {
  /** 被约束的源码目录 */
  from: string;
  /** 禁止指向的目录（绝对路径） */
  forbidden: string[];
  label: string;
}

const RULES: Rule[] = [
  {
    from: path.join(PKG('server'), 'src', 'domain'),
    forbidden: [path.join(PKG('server'), 'src', 'gateway')],
    label: 'domain 不依赖 gateway（领域逻辑不得感知传输层）',
  },
  {
    from: path.join(PKG('server'), 'src', 'pipeline'),
    forbidden: [path.join(PKG('server'), 'src', 'adapters')],
    label: 'pipeline 不依赖 adapters（适配器通过接口注入）',
  },
  {
    from: path.join(PKG('shared'), 'src'),
    forbidden: [path.join(PKG('server'), 'src'), path.join(PKG('web'), 'src')],
    label: 'shared 不依赖 server / web（契约层必须是最低层）',
  },
  {
    from: path.join(PKG('web'), 'src'),
    forbidden: [path.join(PKG('server'), 'src')],
    label: 'web 不直接依赖 server（前端只认 shared 契约）',
  },
];

describe('服务端分层依赖方向', () => {
  for (const rule of RULES) {
    it(rule.label, async () => {
      const files = await sourceFiles(rule.from);
      // 目录被删/改名会让 files 为空，届时下面的循环一次也不跑——必须先守住这一点
      expect(files.length, `${rule.from} 未扫到任何源文件`).toBeGreaterThan(0);

      const violations: string[] = [];
      for (const file of files) {
        const specs = moduleSpecifiers(await readFile(file, 'utf8'), file);
        for (const spec of specs) {
          for (const forbidden of rule.forbidden) {
            if (isUnder(spec, forbidden)) {
              violations.push(`${path.relative(ROOT, file)} → ${path.relative(ROOT, spec)}`);
            }
          }
        }
      }

      // 先收集再统一断言：无论有无违规，本用例都恰好有一条断言被执行
      expect(violations, `${rule.label}\n${violations.join('\n')}`).toEqual([]);
    });
  }
});
