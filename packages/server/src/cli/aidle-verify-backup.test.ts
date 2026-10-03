import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Coc7RuleBook } from '../domain/rulebook/coc7.js';
import { createCsprngRandom } from '../domain/dice/random.js';
import { rollDice } from '../domain/dice/evaluator.js';
import type { DiceAuditEntry } from '../domain/dice/audit.js';
import { runVerifyBackup } from './aidle-verify-backup.js';

/**
 * aidle-verify-backup（T-M10-02，FR-32）：JSONL 解析率 + 骰子审计复算抽样 +
 * rooms/ 存档 JSON 校验。篡改与坏行必须被检出（退出码口径 ok=false）。
 */

const created: string[] = [];
const RULEBOOK = new Coc7RuleBook();

async function makeBackupDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'bv-verify-backup-'));
  created.push(root);
  const dir = path.join(root, 'backup');
  await mkdir(dir, { recursive: true });
  return dir;
}

async function seed(dir: string, rel: string, raw: string): Promise<void> {
  const file = path.join(dir, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, raw, 'utf8');
}

/** 用真实掷骰生成合法审计条目（复算必须一致） */
function makeAuditEntries(count: number, tamperAt?: number): DiceAuditEntry[] {
  const random = createCsprngRandom();
  const entries: DiceAuditEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const roll = rollDice('2d6+3', { random, rulebook: RULEBOOK, kind: 'skill' });
    entries.push({
      seq: String(i + 1).padStart(6, '0'),
      ts: '2026-10-03T00:00:00.000Z',
      rollId: `roll-${i}`,
      roomId: 'room-1',
      sessionId: 'ses-1',
      actor: 'member-1',
      hidden: false,
      expr: roll.expr,
      rolls: roll.rolls,
      kept: roll.kept,
      total: i === tamperAt ? roll.total + 1 : roll.total,
      check: null,
    });
  }
  return entries;
}

afterAll(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('runVerifyBackup', () => {
  it('干净备份：解析率 100%、审计复算全部一致、存档 Schema 通过 → ok', async () => {
    const dir = await makeBackupDir();
    await seed(
      dir,
      'rooms/r1/room.json',
      JSON.stringify({
        schemaVersion: 1,
        id: 'r1',
        name: '备份团',
        createdAt: '2026-10-03T00:00:00.000Z',
        inviteCode: 'BCK123',
        activeSessionId: 's1',
        memberLimit: 8,
        hostToken: 'ht_bak',
      }),
    );
    await seed(dir, 'rooms/r1/sessions/s1/messages.jsonl', '{"seq":1}\n{"seq":2}\n');
    const auditLines = makeAuditEntries(5)
      .map((e) => JSON.stringify(e))
      .join('\n');
    await seed(dir, 'logs/audit-dice.jsonl', `${auditLines}\n`);

    const result = await runVerifyBackup(dir);
    const text = result.lines.join('\n');
    expect(result.ok, text).toBe(true);
    expect(text).toMatch(/JSONL：解析 7 条记录，坏行 0 条/);
    expect(text).toMatch(/审计复算：抽样 5\/5 条，全部一致/);
    expect(text).toMatch(/存档 JSON：检查 1 个，失败 0 个/);
  });

  it('JSONL 坏行 → ok=false 并指明文件', async () => {
    const dir = await makeBackupDir();
    await seed(dir, 'rooms/r1/sessions/s1/messages.jsonl', '{"seq":1}\nnot-json\n');
    const result = await runVerifyBackup(dir);
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toMatch(/messages\.jsonl：坏行 1 条/);
  });

  it('审计流水被篡改 → 复算不一致 → ok=false', async () => {
    const dir = await makeBackupDir();
    const lines = makeAuditEntries(4, 2)
      .map((e) => JSON.stringify(e))
      .join('\n');
    await seed(dir, 'logs/audit-dice.jsonl', `${lines}\n`);
    const result = await runVerifyBackup(dir);
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toMatch(/审计复算：抽样 4\/4 条，1 条不一致/);
  });

  it('存档 JSON 损坏 → ok=false', async () => {
    const dir = await makeBackupDir();
    await seed(dir, 'rooms/r1/room.json', '{ broken');
    const result = await runVerifyBackup(dir);
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toMatch(/room\.json：JSON 损坏/);
  });

  it('v2.0 未迁移镜像（无版本字段）只查解析完整性，不卡 Schema', async () => {
    const dir = await makeBackupDir();
    await seed(dir, 'rooms/r1/room.json', JSON.stringify({ id: 'r1', name: '老团' }));
    const result = await runVerifyBackup(dir);
    const text = result.lines.join('\n');
    expect(result.ok, text).toBe(true);
    expect(text).toMatch(/存档 JSON：检查 1 个，失败 0 个/);
  });

  it('备份目录为空 / 不存在 → ok=false', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'bv-verify-empty-'));
    created.push(root);
    const result = await runVerifyBackup(path.join(root, 'nowhere'));
    expect(result.ok).toBe(false);
  });
});
