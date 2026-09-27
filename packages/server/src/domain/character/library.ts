import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  readCardExtensions,
  type CardEntry,
  type CardImportStep,
  type CharacterCardV3,
} from '@behindveil/shared';
import type { DataLayout } from '../../adapters/storage/layout.js';
import { importCardBytes } from './import.js';

/**
 * 卡库（T-M5-09，FR-08 / TDD §6）：`data/cards/` 下原样存放 PNG / JSON 卡文件。
 *
 * 「原样」是刻意的：社区卡常带立绘与社区字段，v1 不做任何再编码，备份即复制目录。
 * 列表所需的元数据（卡名/来源/规则书）现读现解析——卡库是几十张量级，无需索引文件。
 */

export interface LibraryCard {
  entry: CardEntry;
  card: CharacterCardV3;
}

/** 只保留安全字符、剥离路径分隔符（防穿越）；空名兜底生成 */
export function sanitizeCardFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^A-Za-z0-9._\u4e00-\u9fff-]/g, '_').replace(/^\.+/, '');
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return `card_${randomUUID()}.json`;
  return cleaned;
}

function withSuffix(fileName: string, n: number): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? `${fileName.slice(0, dot)}_${n}${fileName.slice(dot)}` : `${fileName}_${n}`;
}

/** 同名不覆盖：追加序号（两张卡都叫 character.png 是常态） */
async function uniqueFileName(layout: DataLayout, fileName: string): Promise<string> {
  const existing = new Set(await readdir(layout.cardsDir).catch(() => [] as string[]));
  let candidate = fileName;
  let n = 2;
  while (existing.has(candidate)) {
    candidate = withSuffix(fileName, n);
    n += 1;
  }
  return candidate;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function toEntry(
  layout: DataLayout,
  fileName: string,
  bytes: Buffer,
  card: CharacterCardV3,
): Promise<LibraryCard> {
  const info = await stat(join(layout.cardsDir, fileName)).catch(() => null);
  const ext = readCardExtensions(card);
  return {
    entry: {
      id: fileName,
      name: card.data.name,
      spec: 'chara_card_v3',
      rulebook: ext.rulebook,
      kind: ext.pcSheet === null ? 'kp' : 'pc',
      // 按真实字节判定来源，而不是看扩展名（扩展名可以随便改）
      source: bytes.subarray(0, 8).equals(PNG_SIGNATURE) ? 'png' : 'json',
      updatedAt: (info?.mtime ?? new Date()).toISOString(),
    },
    card,
  };
}

export type SaveCardResult =
  | { ok: true; library: LibraryCard }
  /** 导入失败：带上三步流的定位信息，REST 层据此给可诊断的 400（TC-FR-08-005） */
  | { ok: false; step: CardImportStep; message: string };

export async function saveCard(
  layout: DataLayout,
  fileName: string,
  bytes: Buffer,
): Promise<SaveCardResult> {
  const result = importCardBytes(bytes, fileName);
  if (!result.ok) return { ok: false, step: result.step, message: result.message };

  const safeName = await uniqueFileName(layout, sanitizeCardFileName(fileName));
  await mkdir(layout.cardsDir, { recursive: true });
  await writeFile(join(layout.cardsDir, safeName), bytes);
  return { ok: true, library: await toEntry(layout, safeName, bytes, result.card) };
}

/** 单张卡：读文件 → 三步导入；坏卡视为不存在（不因一张坏卡让整个列表失败） */
export async function readCard(layout: DataLayout, cardId: string): Promise<LibraryCard | null> {
  const fileName = sanitizeCardFileName(cardId);
  let bytes: Buffer;
  try {
    bytes = await readFile(join(layout.cardsDir, fileName));
  } catch {
    return null;
  }
  const result = importCardBytes(bytes, fileName);
  if (!result.ok) return null;
  return toEntry(layout, fileName, bytes, result.card);
}

export async function listCards(layout: DataLayout): Promise<LibraryCard[]> {
  let names: string[];
  try {
    // 不过滤扩展名：入库也不按扩展名挑，免得出现「存得进、列不出」的死角
    names = await readdir(layout.cardsDir);
  } catch {
    return []; // 卡库目录尚未创建
  }
  const cards: LibraryCard[] = [];
  for (const name of names.sort()) {
    const found = await readCard(layout, name);
    if (found) cards.push(found);
  }
  return cards;
}

export async function deleteCard(layout: DataLayout, cardId: string): Promise<boolean> {
  try {
    await rm(join(layout.cardsDir, sanitizeCardFileName(cardId)));
    return true;
  } catch {
    return false;
  }
}
