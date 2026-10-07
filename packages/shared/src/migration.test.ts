import { describe, expect, it } from 'vitest';
import { StateBoardSchema } from './domain.js';
import {
  ARCHIVE_KINDS,
  MIGRATORS,
  SCHEMA_VERSION,
  VERSIONLESS,
  migrateArchive,
  readSchemaVersion,
} from './migration.js';

/**
 * 迁移链契约单测（T-M10-01，G-M10「迁移链用例全绿」）。
 * 覆盖：版本判读、v0→v1 补写、幂等（已当前版本原样返回）、
 * 跳版本拒绝（超前版本）、损坏输入拒绝、链契约自检（每步恰好 +1）。
 */

describe('readSchemaVersion', () => {
  it('对象根无 schemaVersion 字段 = VERSIONLESS（v2.0 存量）', () => {
    expect(readSchemaVersion({ id: 'room-1' })).toBe(VERSIONLESS);
  });

  it('数组根 = VERSIONLESS（v2.0 members.json）', () => {
    expect(readSchemaVersion([{ id: 'm1' }])).toBe(VERSIONLESS);
  });

  it('合法整数版本原样返回', () => {
    expect(readSchemaVersion({ schemaVersion: 1, data: {} })).toBe(1);
    expect(readSchemaVersion({ schemaVersion: 0 })).toBe(0);
  });

  it('非整数 / 负数 / 非数字版本 = 损坏输入，拒绝', () => {
    expect(() => readSchemaVersion({ schemaVersion: 1.5 })).toThrow(/非法/);
    expect(() => readSchemaVersion({ schemaVersion: -1 })).toThrow(/非法/);
    expect(() => readSchemaVersion({ schemaVersion: '1' })).toThrow(/非法/);
  });

  it('原始值根（字符串/数字/null）拒绝', () => {
    expect(() => readSchemaVersion('nope')).toThrow(/无法判定版本/);
    expect(() => readSchemaVersion(null)).toThrow(/无法判定版本/);
  });
});

describe('migrateArchive', () => {
  it('v0 对象根补写为当前版本，原 payload 保留、版本字段在首', () => {
    const legacy = { id: 'room-1', name: '老团' };
    const migrated = migrateArchive('room', legacy) as Record<string, unknown>;

    expect(migrated['schemaVersion']).toBe(SCHEMA_VERSION);
    expect(migrated['id']).toBe('room-1');
    expect(migrated['name']).toBe('老团');
    // 首字段（设计 §5.2）：序列化后版本字段排第一
    expect(Object.keys(migrated)[0]).toBe('schemaVersion');
  });

  it('v0 数组根（members）重构为对象根', () => {
    const legacy = [{ id: 'm1', name: 'KP', role: 'host', joinedAt: 't0' }];
    const migrated = migrateArchive('members', legacy) as {
      schemaVersion: number;
      members: unknown[];
    };

    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION);
    expect(migrated.members).toHaveLength(1);
    expect((migrated.members[0] as { id: string }).id).toBe('m1');
  });

  it('已是当前版本 = 原样返回（迁移幂等）', () => {
    const current = { schemaVersion: SCHEMA_VERSION, id: 'room-1' };
    expect(migrateArchive('room', current)).toEqual(current);
  });

  it('版本超前拒绝（存档来自更新版本的服务端）', () => {
    const future = { schemaVersion: SCHEMA_VERSION + 1 };
    expect(() => migrateArchive('room', future)).toThrow(/超前/);
  });

  it('损坏输入（原始值根）拒绝', () => {
    expect(() => migrateArchive('state', 42)).toThrow();
    expect(() => migrateArchive('state', null)).toThrow();
  });

  it('每类存档的链契约成立：从 0 出发逐节点 +1 直到当前版本', () => {
    for (const [kind, migrator] of Object.entries(MIGRATORS)) {
      expect(migrator.currentVersion, kind).toBe(SCHEMA_VERSION);
      let version = VERSIONLESS;
      let doc: unknown = kind === 'members' ? [] : {};
      while (version < migrator.currentVersion) {
        const step = migrator.chain[version];
        expect(step, `${kind} 链缺 ${version}→${version + 1}`).toBeDefined();
        doc = step?.(doc);
        expect(readSchemaVersion(doc), `${kind} 节点 ${version}`).toBe(version + 1);
        version += 1;
      }
    }
  });
});

describe('真实 v2.0 存档迁移 roundtrip（T-M12-04，G-M12 门禁自动化）', () => {
  /**
   * 形态取自 v3 施工期的真实落盘（scripts/make-v20-archives.mjs 同款，G-M10 实跑过）：
   * v1 档号 + 裸字符串 conditions。混合形态（字符串与对象并存）出现在「旧档经开发版
   * 手编」的过渡期——迁移节点对此幂等；无 conditions 字段的 PC 原样保留。
   */
  const v1Sheet = {
    rulebook: 'coc7',
    playerName: '阿珂',
    occupation: '侦探',
    str: 50,
    con: 55,
    siz: 45,
    dex: 70,
    app: 60,
    int: 75,
    pow: 65,
    edu: 80,
    luck: 55,
    hp: 10,
    mp: 13,
    san: 55,
    db: '0',
    build: '0',
    skills: { 侦查: 60 },
  };
  const v1State = {
    schemaVersion: 1,
    version: 12,
    pcs: {
      m1: { sheet: v1Sheet, conditions: ['轻伤', '中毒'] },
      m2: { sheet: v1Sheet, conditions: ['稳定', { label: '重伤', note: '左臂' }] },
      m3: { sheet: v1Sheet, conditions: [] },
    },
    scene: { name: '书房', time: '1924-03-12 深夜', publicDesc: '烛光摇曳' },
    facts: ['书房的窗户从内侧锁着'],
    updatedAt: '2026-09-01T12:00:00.000Z',
  };

  it('state v1→v2：字符串状态升为 { label }，混合/空数组形态原样保留（不嵌套）', () => {
    const migrated = migrateArchive('state', JSON.parse(JSON.stringify(v1State))) as typeof v1State;
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.pcs['m1']?.conditions).toEqual([{ label: '轻伤' }, { label: '中毒' }]);
    expect(migrated.pcs['m2']?.conditions).toEqual([
      { label: '稳定' },
      { label: '重伤', note: '左臂' },
    ]);
    expect(migrated.pcs['m3']?.conditions).toEqual([]);
    // 迁移是纯函数：输入未被改动
    expect(v1State.pcs['m1']?.conditions).toEqual(['轻伤', '中毒']);
  });

  it('迁移产物可被当前 Schema 打开（摘掉版本信封后即运行时状态板）', () => {
    const migrated = migrateArchive('state', JSON.parse(JSON.stringify(v1State))) as Record<
      string,
      unknown
    >;
    const { schemaVersion: _envelope, ...payload } = migrated;
    void _envelope;
    const board = StateBoardSchema.parse(payload);
    expect(board.version).toBe(12);
    expect(board.pcs['m1']?.conditions.map((c) => c.label)).toEqual(['轻伤', '中毒']);
  });

  it('roundtrip 幂等：迁移产物再迁移逐字节一致（重复迁移不产生第二次变化）', () => {
    const once = migrateArchive('state', JSON.parse(JSON.stringify(v1State)));
    const twice = migrateArchive('state', JSON.parse(JSON.stringify(once)));
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it('恒等推进：其余存档 v1→v2 除档号外 payload 逐字段不变（全仓统一档号）', () => {
    // 每类一份真实形态的 v1 payload（字段宽度对齐落盘物）。state 不在此列：
    // 它的 v1→v2 有真实结构变更（conditions 对象化），由上方用例专守。
    const payloads: Array<[(typeof ARCHIVE_KINDS)[number], Record<string, unknown>]> = [
      ['room', { id: 'room-1', name: '老团', inviteCode: 'ABC123', hostToken: 'ht_secret' }],
      ['members', { members: [{ id: 'm1', name: 'KP', role: 'host', joinedAt: 't0' }] }],
      ['worldbook', { entries: [{ uid: 1, key: ['书房'], content: '烛光摇曳' }] }],
      ['roster', { pcs: { m1: { sheet: v1Sheet } } }],
      ['session', { id: 'ses_1', roomId: 'room-1', synopsis: '第一章。', settings: {} }],
    ];
    for (const [kind, payload] of payloads) {
      const v1 = { schemaVersion: 1, ...payload };
      const v2 = migrateArchive(kind, JSON.parse(JSON.stringify(v1)));
      expect(v2, kind).toEqual({ schemaVersion: 2, ...payload });
    }
  });
});
