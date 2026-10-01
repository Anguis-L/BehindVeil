import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Coc7Sheet, StateBoard, StatePatch } from '@behindveil/shared';
import { createDataLayout, type DataLayout } from '../../adapters/storage/layout.js';
import { applyStatePatch, readStateBoard, saveStateBoard } from './board.js';

/**
 * T-M5-06：状态板仓库。读兜底（缺失/损坏 → 空板）、乐观锁补丁（TC-FR-09-001 的
 * 领域侧根基）、原子写回读。并发安全由网关房间串行队列保证，此处测纯函数与 IO 语义。
 */

const created: string[] = [];
let layout: DataLayout;

const baseBoard = (over: Partial<StateBoard> = {}): StateBoard => ({
  version: 2,
  pcs: { m1: { sheet: sheetOf({ san: 55 }), conditions: [] } },
  scene: { name: '书房', time: '1925 年冬夜', publicDesc: '壁炉将熄。' },
  facts: ['书房的门从内侧反锁'],
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const sheetOf = (over: Partial<Coc7Sheet> = {}): Coc7Sheet => ({
  rulebook: 'coc7',
  playerName: '爱丽丝',
  occupation: '记者',
  str: 50,
  con: 60,
  siz: 55,
  dex: 70,
  app: 50,
  int: 75,
  pow: 55,
  edu: 80,
  luck: 40,
  hp: 11,
  mp: 11,
  san: 55,
  db: '0',
  build: '0',
  skills: { 侦查: 60 },
  ...over,
});

beforeAll(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bv-stateboard-'));
  created.push(dir);
  layout = createDataLayout(dir);
});

afterAll(async () => {
  await Promise.all(created.splice(0).map((d) => rm(d, { recursive: true, force: true })));
}, 120_000);

describe('readStateBoard', () => {
  it('缺失 → 空板兜底（version 0，预览与写路径不因状态板挂掉）', async () => {
    expect(await readStateBoard(layout, 'r1', 's1')).toEqual({
      version: 0,
      pcs: {},
      scene: { name: '', time: '', publicDesc: '' },
      facts: [],
      updatedAt: '1970-01-01T00:00:00.000Z',
    });
  });

  it('损坏 → 空板兜底', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(layout.sessionDir('r2', 's2'), { recursive: true });
    await writeFile(layout.stateFile('r2', 's2'), '{ 坏 JSON');
    expect(await readStateBoard(layout, 'r2', 's2')).toMatchObject({ version: 0 });
  });

  it('saveStateBoard 原子写 → readStateBoard 回读一致', async () => {
    const board = baseBoard();
    await saveStateBoard(layout, 'r3', 's3', board);
    expect(await readStateBoard(layout, 'r3', 's3')).toEqual(board);
  });
});

describe('applyStatePatch（乐观锁，TC-FR-09-001 领域侧）', () => {
  it('expectedVersion 命中 → version+1，patch 字段整体覆盖', () => {
    const patch: StatePatch = {
      pcs: { m1: { sheet: sheetOf({ san: 40 }), conditions: ['疯狂(临时)'] } },
      scene: { name: '地下室', time: '凌晨', publicDesc: '楼梯尽头有水声' },
    };
    const result = applyStatePatch(baseBoard(), patch, 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.next.version).toBe(3);
    expect(result.next.pcs.m1?.sheet).toMatchObject({ san: 40 });
    expect(result.next.pcs.m1?.conditions).toEqual(['疯狂(临时)']);
    expect(result.next.scene.name).toBe('地下室');
    expect(result.next.updatedAt).not.toBe('2026-01-01T00:00:00.000Z');
  });

  it('patch 缺省字段保留原值', () => {
    const result = applyStatePatch(baseBoard(), { facts: ['新事实'] }, 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.next.facts).toEqual(['新事实']);
    expect(result.next.pcs.m1?.sheet).toMatchObject({ san: 55 });
    expect(result.next.scene.name).toBe('书房');
  });

  it('expectedVersion 过期 → E-ST-01 拒绝并返回当前板（供广播对齐）', () => {
    const board = baseBoard();
    const result = applyStatePatch(board, { facts: ['迟到的编辑'] }, 1);
    expect(result).toEqual({ ok: false, code: 'E-ST-01', current: board });
  });
});
