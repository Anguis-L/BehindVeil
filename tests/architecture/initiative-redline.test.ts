import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * T-M12-04：看板红线静态检查（FR-37 / ADR-3-06；红线原文见 shared/domain.ts 注记）。
 *
 * 先攻看板只做「数据与展示」：currentIdx / round 的推进一律由 Host 手动点
 * （state:update 通道），服务端与前端都不得存在「自动推进 / 自动结算」代码路径。
 * conditions 的到期（expiresHint）与 resources 的重置（resetOn）同样只是给 Host
 * 的提示，不做自动解除 / 自动重置（conditionText 不含 expiresHint 已在
 * domain.test.ts 专测，此处守住代码路径一侧）。
 *
 * 与 dependency-direction.test.ts 同一手法：直接扫源码，不依赖 lint 配置是否生效。
 * 三层设防：
 *   1. 白名单：允许出现 initiative / currentIdx 的源码文件为固定清单——新文件触碰
 *      看板数据必须有意识地改本用例并写明理由，防写入逻辑悄悄扩散；
 *   2. 定时器禁令：白名单文件内不得出现 setInterval / setTimeout（自动推进的
 *      唯一异步向量；Host 手动点击是同步 UI 事件，不需要定时器）；
 *   3. 命名禁令：全仓源码不得出现 auto-advance / 自动结算语义的命名
 *      （含 web 侧——前端同样没有自动推进的正当性，推进按钮 = Host 手动事件）。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 允许出现 initiative / currentIdx 的源码文件（相对仓库根，/ 分隔）及存在理由 */
const ALLOWLIST: Record<string, string> = {
  'packages/shared/src/domain.ts': 'Initiative/Condition/Resource Schema（数据契约，含红线注记）',
  'packages/shared/src/dice.ts': "骰子种类 kind: 'initiative'（骰卡展示口径）",
  'packages/server/src/domain/rulebook/dnd5e.ts':
    "5e 检定种类 'initiative'（先攻骰判定，非看板推进）",
  'packages/server/src/domain/ai-directive/schema.ts': "check 指令 kind 白名单含 'initiative'",
  'packages/server/src/pipeline/stages.ts': 'S2 状态注入（只读渲染先攻单行，无写入）',
  'packages/web/src/dice-card.ts': '先攻骰卡展示标签',
  'packages/web/src/components/MessageCard.vue':
    '骰子卡「加入先攻」：玩家发起 → 密语 Host（不经看板写入）',
  'packages/web/src/components/StateBoardPanel.vue':
    'Host 手动看板：全部推进/推进回退/清除都是 @click 处理器',
};

/** auto-advance / 自动结算语义的禁用命名（大小写不敏感的词边界匹配） */
const FORBIDDEN_IDENTIFIERS =
  /\b(autoAdvance|autoAdvanceRound|advanceInitiative|autoResolve|autoSettle|settleRound|settleInitiative|autoExpire|expireConditions|autoReset|resetResources|nextTurn|nextRound|autoNext|autoStep|stepRound|tickRound|tickInitiative)\b/i;

async function sourceFiles(): Promise<Map<string, string>> {
  const files = new Map<string, string>();

  async function walk(pkg: string, current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(pkg, full);
      } else if (
        (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) ||
        entry.name.endsWith('.vue')
      ) {
        const rel = path.relative(ROOT, full).replaceAll('\\', '/');
        files.set(rel, await readFile(full, 'utf8'));
      }
    }
  }

  for (const pkg of ['shared', 'server', 'web']) {
    await walk(pkg, path.join(ROOT, 'packages', pkg, 'src'));
  }
  return files;
}

/** 摘掉注释（注释里的示例命名不是代码路径）；字符串字面量原样保留 */
function stripComments(code: string): string {
  let out = '';
  let i = 0;
  while (i < code.length) {
    const two = code.slice(i, i + 2);
    if (two === '//') {
      while (i < code.length && code[i] !== '\n') i += 1;
    } else if (two === '/*') {
      i += 2;
      while (i < code.length && code.slice(i, i + 2) !== '*/') i += 1;
      i += 2;
    } else if (code[i] === '"' || code[i] === "'" || code[i] === '`') {
      const quote = code[i];
      out += code[i];
      i += 1;
      while (i < code.length && code[i] !== quote) {
        if (code[i] === '\\') {
          out += code.slice(i, i + 2);
          i += 2;
        } else {
          out += code[i];
          i += 1;
        }
      }
      if (i < code.length) {
        out += code[i];
        i += 1;
      }
    } else {
      out += code[i];
      i += 1;
    }
  }
  return out;
}

describe('看板红线静态检查（T-M12-04，FR-37 / ADR-3-06）', () => {
  it('全仓确实扫到了三个包的源码（防夹具静默失效）', async () => {
    const files = await sourceFiles();
    expect(files.size).toBeGreaterThan(50);
    for (const pkg of ['packages/shared/src', 'packages/server/src', 'packages/web/src']) {
      expect(
        [...files.keys()].some((rel) => rel.startsWith(pkg)),
        pkg,
      ).toBe(true);
    }
  });

  it('initiative / currentIdx 只出现在白名单文件（新文件触碰看板数据须显式改本用例）', async () => {
    const files = await sourceFiles();
    const offenders = [...files.keys()].filter(
      (rel) => !ALLOWLIST[rel] && /initiative|currentIdx/i.test(files.get(rel) ?? ''),
    );
    expect(
      offenders,
      `以下文件出现先攻看板数据但不在白名单（红线：看板只做数据与展示，推进一律 Host 手动）。` +
        `若属正当用途，把文件加入 tests/architecture/initiative-redline.test.ts 的 ALLOWLIST 并写明理由：\n` +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('白名单文件不含定时器（自动推进的唯一异步向量；Host 推进是同步点击）', async () => {
    const files = await sourceFiles();
    const offenders = Object.keys(ALLOWLIST)
      .filter((rel) => files.has(rel))
      .filter((rel) => /setInterval|setTimeout/.test(stripComments(files.get(rel) ?? '')));
    expect(
      offenders,
      `看板相关文件出现定时器——自动推进代码路径的信号，违反看板红线：\n${offenders.join('\n')}`,
    ).toEqual([]);
    // 白名单必须与仓库实况对齐：条目指向的文件被删除/改名时在此暴露
    const missing = Object.keys(ALLOWLIST).filter((rel) => !files.has(rel));
    expect(missing, `白名单条目指向不存在的文件：\n${missing.join('\n')}`).toEqual([]);
  });

  it('全仓无 auto-advance / 自动结算语义的命名', async () => {
    const files = await sourceFiles();
    const offenders = [...files.entries()]
      .filter(([, code]) => FORBIDDEN_IDENTIFIERS.test(stripComments(code)))
      .map(([rel]) => rel);
    expect(
      offenders,
      `出现自动推进/自动结算语义命名（看板红线：推进与结算一律 Host 手动）：\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('服务端源码不出现对看板字段的成员赋值（推进只能在 web Host UI 的草稿上，经 state:update 落盘）', async () => {
    const files = await sourceFiles();
    const offenders = [...files.entries()]
      .filter(([rel]) => rel.startsWith('packages/server/src'))
      .filter(([, code]) => /\.(currentIdx|round|initiative)\s*=[^=>]/.test(stripComments(code)))
      .map(([rel]) => rel);
    expect(
      offenders,
      `服务端直接赋值看板字段（服务端对先攻只应做 schema 校验、注入与 Host patch 透传）：\n` +
        offenders.join('\n'),
    ).toEqual([]);
  });
});
