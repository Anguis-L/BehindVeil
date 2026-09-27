import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataLayout, type DataLayout } from '../../adapters/storage/layout.js';
import { declarePc, readRoomRoster, undeclarePc, type DeclaredPc } from './declare.js';

/**
 * T-M5-04：房间级 PC 声明（roster.json）。声明/覆盖/撤销与兜底语义；
 * 「声明 → 开团装配进状态板初始」的联动在 sessions.test.ts 侧覆盖。
 */

const created: string[] = [];
let layout: DataLayout;

const declaredOf = (over: Partial<DeclaredPc> = {}): DeclaredPc => ({
  sheet: {
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
  },
  source: 'manual',
  ...over,
});

beforeAll(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bv-roster-'));
  created.push(dir);
  layout = createDataLayout(dir);
});

afterAll(async () => {
  await Promise.all(created.splice(0).map((d) => rm(d, { recursive: true, force: true })));
}, 120_000);

describe('房间级 PC 声明', () => {
  it('文件缺失 → 空名册兜底', async () => {
    expect(await readRoomRoster(layout, 'r1')).toEqual({ pcs: {} });
  });

  it('declarePc 写入并回读；重复声明（PUT 幂等）覆盖', async () => {
    await declarePc(layout, 'r2', 'm1', declaredOf());
    expect(await readRoomRoster(layout, 'r2')).toMatchObject({
      pcs: { m1: { source: 'manual', sheet: { playerName: '爱丽丝' } } },
    });
    await declarePc(layout, 'r2', 'm1', declaredOf({ source: 'card', cardId: 'alice.png' }));
    const roster = await readRoomRoster(layout, 'r2');
    expect(roster.pcs['m1']).toMatchObject({ source: 'card', cardId: 'alice.png' });
  });

  it('undeclarePc：存在 → true 并删除；不存在 → false', async () => {
    await declarePc(layout, 'r3', 'm1', declaredOf());
    expect(await undeclarePc(layout, 'r3', 'm1')).toBe(true);
    expect((await readRoomRoster(layout, 'r3')).pcs['m1']).toBeUndefined();
    expect(await undeclarePc(layout, 'r3', 'm1')).toBe(false);
  });

  it('损坏文件 → 读空名册兜底（不挡开团）；写路径按 JsonStore 语义抛错', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(layout.roomDir('r4'), { recursive: true });
    await writeFile(layout.rosterFile('r4'), '不是 JSON');
    expect(await readRoomRoster(layout, 'r4')).toEqual({ pcs: {} });
    await expect(declarePc(layout, 'r4', 'm1', declaredOf())).rejects.toThrow(SyntaxError);
  });
});
