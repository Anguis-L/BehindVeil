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
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

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

const importLines = (code: string): string[] =>
  code
    .split('\n')
    .filter((line) => /^\s*(import|export)\b.*from\s+['"]/.test(line))
    .map((line) => line.trim());

describe('服务端分层依赖方向', () => {
  it('domain 不依赖 gateway（领域逻辑不得感知传输层）', async () => {
    const files = await sourceFiles(path.join(ROOT, 'packages/server/src/domain'));

    for (const file of files) {
      const code = await readFile(file, 'utf8');
      for (const line of importLines(code)) {
        expect(line, `${file} 违规引用 gateway`).not.toMatch(/['"].*gateway/);
      }
    }
  });

  it('pipeline 不依赖 adapters（适配器通过接口注入）', async () => {
    const files = await sourceFiles(path.join(ROOT, 'packages/server/src/pipeline'));

    for (const file of files) {
      const code = await readFile(file, 'utf8');
      for (const line of importLines(code)) {
        expect(line, `${file} 违规引用 adapters`).not.toMatch(/['"].*adapters/);
      }
    }
  });

  it('shared 不依赖 server / web（契约层必须是最低层）', async () => {
    const files = await sourceFiles(path.join(ROOT, 'packages/shared/src'));

    for (const file of files) {
      const code = await readFile(file, 'utf8');
      for (const line of importLines(code)) {
        expect(line, `${file} 反向依赖上层包`).not.toMatch(/@behindveil\/(server|web)/);
      }
    }
  });

  it('web 不直接依赖 server（前端只认 shared 契约）', async () => {
    const files = await sourceFiles(path.join(ROOT, 'packages/web/src'));

    for (const file of files) {
      const code = await readFile(file, 'utf8');
      for (const line of importLines(code)) {
        expect(line, `${file} 直接引用了服务端`).not.toMatch(/@behindveil\/server/);
      }
    }
  });
});
