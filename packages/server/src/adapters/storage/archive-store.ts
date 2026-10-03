import { MIGRATORS, SCHEMA_VERSION, readSchemaVersion, type ArchiveKind } from '@behindveil/shared';
import { JsonStore } from './json-store.js';

/**
 * 带版本的存档存储（T-M10-01，FR-30 / ADR-3-05）。
 *
 * 在 JsonStore 原子写之上加 schemaVersion 信封（设计 §5.2「首字段」）：
 * - 写：`{ schemaVersion: SCHEMA_VERSION, ...payload }`（members 为数组根，包装为
 *   `{ schemaVersion, members }`——数组无法内联字段，v1 起重构为对象根）；
 * - 读：校验版本后剥掉信封字段，返回裸 payload——领域层类型与 v2 完全一致；
 * - 版本不符（低于当前 = 未迁移 / 高于当前 = 存档来自更新服务端）一律抛错：
 *   宁可拒绝，不静默猜（启动门禁是第一道防线，此处是防文件被运行中调换的第二道）。
 *
 * 并发语义沿用 JsonStore（按路径串行 + update 读改写关锁）。
 */

/** 版本不符时抛出；message 即面向用户的选择题：迁移或放弃 */
export class ArchiveVersionError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly found: number,
    detail: string,
  ) {
    super(`${filePath}：存档版本 ${found}，${detail}（可运行 pnpm aidle-migrate 迁移存档）`);
    this.name = 'ArchiveVersionError';
  }
}

/** members.json v1 起为 `{ schemaVersion, members: Member[] }`（数组根无法内联版本字段） */
function isMembersKind(kind: ArchiveKind): boolean {
  return kind === 'members';
}

export class ArchiveJsonStore {
  private readonly inner: JsonStore;
  private readonly currentVersion: number;

  constructor(
    private readonly filePath: string,
    private readonly kind: ArchiveKind,
  ) {
    this.inner = new JsonStore(filePath);
    this.currentVersion = MIGRATORS[kind].currentVersion;
  }

  async write(payload: unknown): Promise<void> {
    return this.inner.write(this.envelope(payload));
  }

  /** 文件不存在返回 null；版本不符 / 信封非法抛 ArchiveVersionError */
  async read(): Promise<unknown | null> {
    const raw = await this.inner.read();
    if (raw === null) return null;
    return this.unwrap(raw);
  }

  /** 读改写（同 JsonStore.update 语义：整段在文件锁内；mutate 收到/返回裸 payload） */
  async update<T>(mutate: (current: unknown | null) => T): Promise<T> {
    let payload!: T; // mutate 在 JsonStore 文件锁内必然执行一次
    await this.inner.update((raw) => {
      const current = raw === null ? null : this.unwrap(raw);
      payload = mutate(current);
      return this.envelope(payload);
    });
    return payload;
  }

  private envelope(payload: unknown): unknown {
    if (isMembersKind(this.kind)) {
      if (!Array.isArray(payload)) {
        throw new TypeError(
          'members 存档 payload 必须是数组（v1 起对象根 { schemaVersion, members }）',
        );
      }
      return { schemaVersion: SCHEMA_VERSION, members: payload };
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new TypeError(`${this.kind} 存档 payload 必须是对象根`);
    }
    return { schemaVersion: SCHEMA_VERSION, ...(payload as Record<string, unknown>) };
  }

  private unwrap(raw: unknown): unknown {
    const version = readSchemaVersion(raw);
    if (version > this.currentVersion) {
      throw new ArchiveVersionError(
        this.filePath,
        version,
        `超前于当前支持的 ${this.currentVersion}（存档来自更新版本的服务端，不能降级打开）`,
      );
    }
    if (version < this.currentVersion) {
      throw new ArchiveVersionError(
        this.filePath,
        version,
        `低于当前要求的 ${this.currentVersion}（未迁移的存量存档）`,
      );
    }
    if (isMembersKind(this.kind)) {
      return (raw as { members?: unknown })['members'];
    }
    const { schemaVersion: _schemaVersion, ...payload } = raw as Record<string, unknown>;
    return payload;
  }
}
