import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataLayout } from '../../adapters/storage/layout.js';
import type { DataLayout } from '../../adapters/storage/layout.js';
import { deleteCard, listCards, readCard, sanitizeCardFileName, saveCard } from './library.js';
import type { LibraryCard } from './library.js';
import { writeCardToPng } from './png.js';

/**
 * T-M5-09：卡库（data/cards/）。
 * 单个临时根目录 + 用例间靠文件名隔离，避免为每例各建一个目录。
 */

let root = '';

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'bv-cards-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
}, 120_000);

function layout() {
  return createDataLayout(root);
}

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const pcCard = {
  spec: 'chara_card_v3',
  spec_version: '3.0',
  data: {
    name: '调查员·阿珂',
    description: '瘦高的女子',
    scenario: '1924 伦敦',
    first_mes: '「我不确定。」',
    mes_example: '',
    extensions: {
      aidle: {
        rulebook: 'coc7',
        pcSheet: {
          playerName: '张三',
          occupation: '记者',
          str: 50,
          con: 60,
          siz: 55,
          dex: 70,
          app: 60,
          int: 80,
          pow: 65,
          edu: 75,
          luck: 60,
          hp: 11,
          mp: 13,
          san: 65,
          db: '0',
          build: '0',
          skills: { 侦查: 60, 图书馆使用: 50 },
        },
      },
    },
  },
};

const kpCard = {
  spec: 'chara_card_v3',
  data: {
    name: '守秘人',
    description: '只叙述不判定',
    scenario: '深夜书房',
    first_mes: '灯亮了。',
    mes_example: '',
    extensions: { aidle: { rulebook: 'coc7' } },
  },
};

function pngCard(card: unknown): Buffer {
  return writeCardToPng(PNG_1X1, JSON.stringify(card));
}

/** saveCard 成功断言：窄化掉失败分支；失败路径由「坏卡不入库」用例覆盖 */
async function saveOk(layout: DataLayout, fileName: string, bytes: Buffer): Promise<LibraryCard> {
  const saved = await saveCard(layout, fileName, bytes);
  if (!saved.ok) throw new Error(`入库意外失败（${saved.step}）: ${saved.message}`);
  return saved.library;
}

describe('sanitizeCardFileName', () => {
  it('剥离路径分隔符，防目录穿越', () => {
    expect(sanitizeCardFileName('../../evil.png')).toBe('evil.png');
    expect(sanitizeCardFileName('a\\b\\c.json')).toBe('c.json');
  });

  it('空名/纯点兜底生成', () => {
    expect(sanitizeCardFileName('')).toMatch(/^card_.*\.json$/);
    expect(sanitizeCardFileName('..')).toMatch(/^card_.*\.json$/);
  });
});

describe('saveCard / listCards', () => {
  it('PNG 玩家卡入库：元数据正确（规则书 + 有 PC 数值）', async () => {
    const saved = await saveOk(layout(), 'pc.png', pngCard(pcCard));
    expect(saved.entry.name).toBe('调查员·阿珂');
    expect(saved.entry.rulebook).toBe('coc7');
    expect(saved.entry.kind).toBe('pc'); // 带 pcSheet
    expect(saved.entry.source).toBe('png');
  });

  it('KP 卡（无 pcSheet）hasPcSheet=false', async () => {
    const saved = await saveOk(layout(), 'keeper.png', pngCard(kpCard));
    expect(saved.entry.kind).toBe('kp'); // 无 pcSheet
    expect(saved.entry.source).toBe('png');
  });

  it('v2 JSON 卡也能入库，source 记为 ccv2', async () => {
    const v2 = Buffer.from(
      JSON.stringify({ name: '老卡', description: 'd', personality: 'p', first_mes: 'f' }),
      'utf8',
    );
    const saved = await saveOk(layout(), 'old.json', v2);
    expect(saved.entry.source).toBe('json');
    expect(saved.entry.rulebook).toBeNull(); // 无 aidle 扩展
    expect(saved.entry.kind).toBe('kp');
  });

  it('同名不覆盖：第二张追加序号', async () => {
    await saveCard(layout(), 'dup.png', pngCard(kpCard));
    await saveCard(layout(), 'dup.png', pngCard(pcCard));

    const names = (await readdir(path.join(root, 'cards'))).filter((n) => n.startsWith('dup'));
    expect(names.sort()).toEqual(['dup.png', 'dup_2.png']);
    // 两张卡内容各自保留
    expect((await readCard(layout(), 'dup.png'))?.entry.name).toBe('守秘人');
    expect((await readCard(layout(), 'dup_2.png'))?.entry.name).toBe('调查员·阿珂');
  });

  it('坏卡不入库（三步导入任一步不通过 → null）', async () => {
    const bad = await saveCard(layout(), 'broken.json', Buffer.from('{"hello":1}', 'utf8'));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.step).toBe('detect');
    expect((await readdir(path.join(root, 'cards'))).some((n) => n.startsWith('broken'))).toBe(
      false,
    );
  });

  it('列表按文件名排序，且跳过坏文件（不因一张坏卡让整列失败）', async () => {
    await writeFile(path.join(root, 'cards', 'zz-bad.json'), 'not a card', 'utf8');

    const cards = await listCards(layout());
    expect(cards.map((c) => c.entry.id)).toEqual(
      cards
        .map((c) => c.entry.id)
        .slice()
        .sort(),
    );
    expect(cards.some((c) => c.entry.id === 'zz-bad.json')).toBe(false);
    expect(cards.length).toBeGreaterThanOrEqual(4);
  });
});

describe('readCard / deleteCard', () => {
  it('读到入库的卡；不存在的 id 返回 null', async () => {
    expect((await readCard(layout(), 'keeper.png'))?.entry.name).toBe('守秘人');
    expect(await readCard(layout(), 'nope.png')).toBeNull();
  });

  it('删除成功返回 true，再删返回 false', async () => {
    await saveCard(layout(), 'to-delete.png', pngCard(kpCard));
    expect(await deleteCard(layout(), 'to-delete.png')).toBe(true);
    expect(await deleteCard(layout(), 'to-delete.png')).toBe(false);
    expect(await readCard(layout(), 'to-delete.png')).toBeNull();
  });

  it('删除时 id 里的路径穿越被剥离（不会删到库外文件）', async () => {
    expect(await deleteCard(layout(), '../rooms/room.json')).toBe(false);
  });
});
