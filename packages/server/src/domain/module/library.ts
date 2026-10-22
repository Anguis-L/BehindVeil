import {
  CharacterCardV3Schema,
  InitStateSchema,
  ModuleManifestSchema,
  WorldBookSchema,
  type CharacterCardV3,
  type InitState,
  type ModuleInfo,
  type ModuleManifest,
  type WorldBook,
} from '@behindveil/shared';
import { existsSync } from 'node:fs';
import { cp, readdir, rm, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore } from '../../adapters/storage/json-store.js';
import type { DataLayout } from '../../adapters/storage/layout.js';
import { listRoomFiles } from '../session/rooms.js';
import { readSession } from '../session/sessions.js';

/**
 * 模组包仓库（T-M5-05，FR-10 / TDD §3.6）。
 *
 * 文件系统即真相（ADR-03，卡库同款）：已放置 = `data/modules/<dir>/`，
 * 「加载」= 校验通过（manifest + 三件套可解析），无独立登记表。
 * 卸载策略 D-09：被活跃会话引用（moduleRef）时拒绝（E-MOD-01），空闲即删目录。
 * 历史会话的 moduleRef 不参与判据（决议口径为「活跃 Session 引用」）；
 * 复播已卸载模组的旧团属于重装场景，v1 不做拦截。
 */

export interface LoadedModule {
  manifest: ModuleManifest;
  kpCard: CharacterCardV3;
  worldBook: WorldBook;
  initState: InitState;
  /** 目录名 = manifest.id（装载时强校验一致） */
  dirName: string;
}

export type LoadModuleResult =
  | { ok: true; module: LoadedModule }
  | {
      ok: false;
      /** not-found=目录不存在；path=目录名非法；manifest=manifest 缺失/字段/apiVersion 不符；entry=三件套缺失或不可解析 */
      reason: 'not-found' | 'path' | 'manifest' | 'entry';
      message: string;
    };

/** 模组定位只允许单段目录名（防路径穿越，卡库 sanitize 同思路） */
function sanitizeDirName(name: string): string | null {
  if (name === '' || name === '.' || name === '..') return null;
  if (name.includes('/') || name.includes('\\')) return null;
  return name;
}

async function readJsonFile(filePath: string): Promise<unknown> {
  return new JsonStore(filePath).read().catch(() => null);
}

/** 加载 = 校验：目录存在 → manifest（含 apiVersion literal）→ entry 三件逐个解析（TC-FR-10-001） */
export async function loadModule(layout: DataLayout, dirName: string): Promise<LoadModuleResult> {
  const safe = sanitizeDirName(dirName);
  if (!safe) return { ok: false, reason: 'path', message: '模组目录名不合法' };
  const dir = join(layout.modulesDir, safe);
  try {
    await stat(dir);
  } catch {
    return { ok: false, reason: 'not-found', message: '模组不存在' };
  }

  const manifestRaw = await readJsonFile(join(dir, 'manifest.json'));
  const manifest = ModuleManifestSchema.safeParse(manifestRaw);
  if (!manifest.success) {
    const issue = manifest.error.issues[0];
    const where = issue ? issue.path.join('.') : '(根)';
    return {
      ok: false,
      reason: 'manifest',
      message: `manifest.json 校验失败（${where}）：${issue?.message ?? '无法解析'}`,
    };
  }
  if (manifest.data.id !== safe) {
    return {
      ok: false,
      reason: 'manifest',
      message: `manifest.id（${manifest.data.id}）与目录名（${safe}）不一致`,
    };
  }

  const kpCardRaw = await readJsonFile(join(dir, manifest.data.entry.kpCard));
  const kpCard = CharacterCardV3Schema.safeParse(kpCardRaw);
  if (!kpCard.success) {
    return {
      ok: false,
      reason: 'entry',
      message: `KP 卡（${manifest.data.entry.kpCard}）无法解析`,
    };
  }
  const worldBookRaw = await readJsonFile(join(dir, manifest.data.entry.worldBook));
  const worldBook = WorldBookSchema.safeParse(worldBookRaw);
  if (!worldBook.success) {
    return {
      ok: false,
      reason: 'entry',
      message: `世界书（${manifest.data.entry.worldBook}）无法解析`,
    };
  }
  const initStateRaw = await readJsonFile(join(dir, manifest.data.entry.initState));
  const initState = InitStateSchema.safeParse(initStateRaw);
  if (!initState.success) {
    return {
      ok: false,
      reason: 'entry',
      message: `init-state（${manifest.data.entry.initState}）无法解析`,
    };
  }

  return {
    ok: true,
    module: {
      manifest: manifest.data,
      kpCard: kpCard.data,
      worldBook: worldBook.data,
      initState: initState.data,
      dirName: safe,
    },
  };
}

/** 引用该模组的活跃会话数（D-09 判据；scan = 房间 → activeSessionId → moduleRef） */
export async function countActiveSessions(layout: DataLayout, moduleId: string): Promise<number> {
  const rooms = await listRoomFiles(layout);
  let count = 0;
  for (const room of rooms) {
    if (!room.activeSessionId) continue;
    const session = await readSession(layout, room.id, room.activeSessionId);
    if (session?.moduleRef === moduleId) count += 1;
  }
  return count;
}

export async function listModules(layout: DataLayout): Promise<ModuleInfo[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(layout.modulesDir, { withFileTypes: true });
  } catch {
    return []; // modules/ 尚未创建
  }
  const infos: ModuleInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const loaded = await loadModule(layout, entry.name);
    if (!loaded.ok) continue; // 坏包视为不存在（卡库同款容错）
    const { manifest } = loaded.module;
    infos.push({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      rulebook: manifest.rulebook,
      apiVersion: manifest.apiVersion,
      activeSessions: await countActiveSessions(layout, manifest.id),
    });
  }
  return infos.sort((a, b) => a.id.localeCompare(b.id));
}

export interface SampleInstallResult {
  /** 目录名 = manifest.id */
  id: string;
  name: string | undefined;
  rulebook: string | undefined;
  /** installed=本次装上；already=之前已装（不覆盖用户的改动）；skipped=校验不过已回滚 */
  status: 'installed' | 'already' | 'skipped';
  message: string | undefined;
}

/**
 * 内置示例剧本的源目录定位（2026-10-08 可用性改造）。
 *
 * 发布包与源码树都带 `examples/modules`（release.yml 显式 cp）；从本文件出发逐级上溯
 * 找到即止——dist（packages/server/dist/...）与 src 两种运行位置都能命中。
 * 找不到返回 undefined（前端按钮不出现，功能静默缺席，不报错）。
 */
export function findSampleModulesDir(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, 'examples', 'modules');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  return undefined;
}

/**
 * 装载内置示例剧本（幂等）：复制进 `data/modules/<id>/` 后逐包校验，
 * 校验不过**整目录回滚**（不留坏包污染列表）。已存在的同名目录不覆盖——
 * 用户可能改过世界书，覆盖等于静默毁数据。
 */
export async function installSampleModules(
  layout: DataLayout,
): Promise<{ ok: true; modules: SampleInstallResult[] } | { ok: false; message: string }> {
  const src = findSampleModulesDir();
  if (src === undefined) {
    return { ok: false, message: '未找到内置示例剧本（examples/modules），请手动放置模组目录' };
  }
  const names = (await readdir(src, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
  if (names.length === 0) return { ok: false, message: '内置示例剧本目录为空' };

  const results: SampleInstallResult[] = [];
  for (const name of names) {
    const dest = join(layout.modulesDir, name);
    if (existsSync(dest)) {
      const probe = await loadModule(layout, name);
      results.push({
        id: name,
        name: probe.ok ? probe.module.manifest.name : undefined,
        rulebook: probe.ok ? probe.module.manifest.rulebook : undefined,
        status: 'already',
        message: undefined,
      });
      continue;
    }
    await cp(join(src, name), dest, { recursive: true });
    const probe = await loadModule(layout, name);
    if (!probe.ok) {
      await rm(dest, { recursive: true, force: true });
      results.push({
        id: name,
        name: undefined,
        rulebook: undefined,
        status: 'skipped',
        message: probe.message,
      });
      continue;
    }
    results.push({
      id: name,
      name: probe.module.manifest.name,
      rulebook: probe.module.manifest.rulebook,
      status: 'installed',
      message: undefined,
    });
  }
  return { ok: true, modules: results };
}

export type UnloadModuleResult =
  { ok: true } | { ok: false; reason: 'not-found' | 'path' | 'in-use'; message: string };

/** 卸载（D-09）：活跃会话引用中 → in-use 拒绝（E-MOD-01）；空闲即整目录移除 */
export async function unloadModule(
  layout: DataLayout,
  dirName: string,
): Promise<UnloadModuleResult> {
  const safe = sanitizeDirName(dirName);
  if (!safe) return { ok: false, reason: 'path', message: '模组目录名不合法' };

  const dir = join(layout.modulesDir, safe);
  const probe = await loadModule(layout, safe);
  if (!probe.ok && probe.reason === 'not-found') {
    return { ok: false, reason: 'not-found', message: '模组不存在' };
  }
  if (probe.ok && (await countActiveSessions(layout, probe.module.manifest.id)) > 0) {
    return { ok: false, reason: 'in-use', message: '模组使用中，无法卸载' };
  }
  await rm(dir, { recursive: true, force: true });
  return { ok: true };
}
