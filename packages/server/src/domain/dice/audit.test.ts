import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { RollCheck } from '@behindveil/shared';
import { createDataLayout } from '../../adapters/storage/layout.js';
import { createDiceAuditor, type DiceAuditInput } from './audit.js';

/**
 * T-M4-01：骰子审计流水（TDD §3.5/§6、NFR-04；复现语义按决议 D-04）。
 * 覆盖：流水号单调与重启续写、rollId 唯一、并发不撞号、坏行容错、
 * 落账即已落盘（WAP 同侧）、暗骰与 AI 骰照记。
 */

const created: string[] = [];

async function makeLayout(): Promise<ReturnType<typeof createDataLayout>> {
  const dir = await mkdtemp(path.join(tmpdir(), 'bv-audit-'));
  created.push(dir);
  return createDataLayout(dir);
}

afterAll(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const CHECK: RollCheck = {
  rulebook: 'coc7',
  kind: 'skill',
  target: 50,
  difficulty: 'normal',
  outcome: 'success',
  grade: 'hard',
};

function input(overrides: Partial<DiceAuditInput> = {}): DiceAuditInput {
  return {
    roomId: 'room-1',
    sessionId: 'session-1',
    actor: 'member-1',
    hidden: false,
    expr: '1d100<=50',
    rolls: [[42]],
    kept: [42],
    total: 42,
    check: CHECK,
    ...overrides,
  };
}

describe('落账与流水号（T-M4-01）', () => {
  it('首次落账返回 seq=000001 与 rollId，并落盘为完整一行', async () => {
    const layout = await makeLayout();
    const auditor = createDiceAuditor(layout, { newRollId: () => 'roll-fixed-1' });

    const audit = await auditor.record(input());

    expect(audit.seq).toBe('000001');
    expect(audit.rollId).toBe('roll-fixed-1');
    expect(Date.parse(audit.ts)).not.toBeNaN();

    const raw = await readFile(layout.auditDiceFile, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(JSON.parse(raw.trim())).toMatchObject({
      seq: '000001',
      rollId: 'roll-fixed-1',
      expr: '1d100<=50',
      rolls: [[42]],
      kept: [42],
      total: 42,
      check: CHECK,
      roomId: 'room-1',
      sessionId: 'session-1',
      actor: 'member-1',
      hidden: false,
    });
    await auditor.close();
  });

  it('流水号逐条递增（零填充，字典序与数值序一致）', async () => {
    const layout = await makeLayout();
    const auditor = createDiceAuditor(layout);

    const first = await auditor.record(input());
    const second = await auditor.record(input({ hidden: true }));
    const third = await auditor.record(input());

    expect([first.seq, second.seq, third.seq]).toEqual(['000001', '000002', '000003']);
    await auditor.close();
  });

  it('重启后从文件尾部续写（不重复、不回退）', async () => {
    const layout = await makeLayout();
    const first = createDiceAuditor(layout);
    await first.record(input());
    await first.record(input());
    await first.close();

    const restarted = createDiceAuditor(layout);
    const next = await restarted.record(input());

    expect(next.seq).toBe('000003');
    const { entries } = await restarted.readAll();
    expect(entries.map((e) => e.seq)).toEqual(['000001', '000002', '000003']);
    await restarted.close();
  });

  it('rollId 逐条唯一（CSPRNG，无种子语义）', async () => {
    const layout = await makeLayout();
    const auditor = createDiceAuditor(layout);

    const ids = new Set<string>();
    for (let i = 0; i < 20; i += 1) ids.add((await auditor.record(input())).rollId);

    expect(ids.size).toBe(20);
    await auditor.close();
  });

  it('跨房间并发落账不撞号（写串行保证 seq 与落盘同序）', async () => {
    const layout = await makeLayout();
    const auditor = createDiceAuditor(layout);

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => auditor.record(input({ roomId: `room-${i}` }))),
    );

    const seqs = results.map((r) => r.seq);
    expect(new Set(seqs).size).toBe(20);
    // 并发下 rollId 同样不得撞号：审计号是凭据主键，撞了就无法唯一定位一颗骰子
    const rollIds = results.map((r) => r.rollId);
    expect(new Set(rollIds).size, '并发落账的 rollId 必须互不相同').toBe(20);

    const { entries } = await auditor.readAll();
    expect(entries).toHaveLength(20);
    // 落盘顺序与流水号顺序一致
    const raw = await readFile(layout.auditDiceFile, 'utf8');
    const onDisk = raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { seq: string });
    expect(onDisk.map((e) => e.seq)).toEqual(seqs);
    await auditor.close();
  });
});

describe('落账即已落盘（WAP 同侧）', () => {
  it('record 返回后该行可回读（先落审计后广播的前提）', async () => {
    const layout = await makeLayout();
    const auditor = createDiceAuditor(layout);

    const audit = await auditor.record(input({ expr: '2d6+1' }));
    const { entries } = await auditor.readAll();

    expect(entries).toHaveLength(1);
    expect(entries[0]?.seq).toBe(audit.seq);
    await auditor.close();
  });
});

describe('审计完整性（暗骰与 AI 骰照记）', () => {
  it('暗骰落账：hidden 仅作标记，数值照样完整留痕', async () => {
    const layout = await makeLayout();
    const auditor = createDiceAuditor(layout);

    await auditor.record(input({ hidden: true }));
    const { entries } = await auditor.readAll();

    expect(entries[0]?.hidden).toBe(true);
    expect(entries[0]?.total).toBe(42);
    expect(entries[0]?.rolls).toEqual([[42]]);
    await auditor.close();
  });

  it('AI 检定骰 actor=null（引擎代掷，非任何成员）', async () => {
    const layout = await makeLayout();
    const auditor = createDiceAuditor(layout);

    await auditor.record(input({ actor: null }));
    const { entries } = await auditor.readAll();

    expect(entries[0]?.actor).toBeNull();
    await auditor.close();
  });
});

describe('坏行容错（NFR-06 同口径）', () => {
  it('readAll 跳过非法 JSON 与 Schema 不符的行并计数', async () => {
    const layout = await makeLayout();
    const auditor = createDiceAuditor(layout);
    await auditor.record(input());

    await writeFile(
      layout.auditDiceFile,
      `${JSON.stringify({ seq: '000002', expr: '1d100' })}\n{ 不是 JSON\n`,
      { flag: 'a' },
    );

    const { entries, badLines } = await auditor.readAll();
    expect(entries).toHaveLength(1); // 缺字段的那条按 Schema 不符处理
    expect(badLines).toBe(2);
    await auditor.close();
  });

  it('恢复时跳过 Schema 不符的行（JSON 合法但字段缺失）', async () => {
    const layout = await makeLayout();
    const first = createDiceAuditor(layout);
    await first.record(input());
    await first.close();

    await writeFile(layout.auditDiceFile, `${JSON.stringify({ seq: '000002', expr: '1d100' })}\n`, {
      flag: 'a',
    });

    const restarted = createDiceAuditor(layout);
    const next = await restarted.record(input());

    expect(next.seq).toBe('000002'); // 缺字段那条被跳过，不据其续号
    await restarted.close();
  });

  it('尾部撕裂行不影响重启续写（回溯到最后一个可解析行）', async () => {
    const layout = await makeLayout();
    const first = createDiceAuditor(layout);
    await first.record(input());
    await first.record(input());
    await first.close();

    // 模拟崩溃留下的半行
    await writeFile(layout.auditDiceFile, '{"seq":"000003","ex', { flag: 'a' });

    const restarted = createDiceAuditor(layout);
    const next = await restarted.record(input());

    expect(next.seq).toBe('000003'); // 撕裂行未被计入，续写不跳号
    await restarted.close();
  });
});
