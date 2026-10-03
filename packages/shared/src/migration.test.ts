import { describe, expect, it } from 'vitest';
import {
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
