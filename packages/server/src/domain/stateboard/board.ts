import { StateBoardSchema, type StateBoard, type StatePatch } from '@behindveil/shared';
import { JsonStore } from '../../adapters/storage/json-store.js';
import type { DataLayout } from '../../adapters/storage/layout.js';

/**
 * 状态板仓库（T-M5-06，TDD §3.7/§5.5 / SDD §3.7）。
 *
 * 读：state.json 缺失或损坏时以空板兜底（预览与写路径都不因状态板挂掉）；
 * 写：JsonStore 原子写（tmp+rename，CODING_STANDARDS §2.3）。
 * 乐观锁（E-ST-01）：version 比对收在纯函数 applyStatePatch 内；
 * 并发安全由网关房间串行队列保证（v1 单进程，与消息主链路同一把队）。
 */

const EMPTY_UPDATED_AT = '1970-01-01T00:00:00.000Z';

/** 空板兜底（预览 T-M2-05 同款哨兵时间；写路径兜底后首个 patch 会刷新 updatedAt） */
export function emptyStateBoard(): StateBoard {
  return {
    version: 0,
    pcs: {},
    scene: { name: '', time: '', publicDesc: '' },
    facts: [],
    updatedAt: EMPTY_UPDATED_AT,
  };
}

export async function readStateBoard(
  layout: DataLayout,
  roomId: string,
  sessionId: string,
): Promise<StateBoard> {
  // JsonStore 对损坏 JSON 抛错（由调用方降级）：状态板挂掉不该挡预览与写路径，空板兜底
  const raw = await new JsonStore(layout.stateFile(roomId, sessionId)).read().catch(() => null);
  const parsed = StateBoardSchema.safeParse(raw);
  return parsed.success ? parsed.data : emptyStateBoard();
}

export async function saveStateBoard(
  layout: DataLayout,
  roomId: string,
  sessionId: string,
  board: StateBoard,
): Promise<void> {
  await new JsonStore(layout.stateFile(roomId, sessionId)).write(board);
}

export type StatePatchResult =
  { ok: true; next: StateBoard } | { ok: false; code: 'E-ST-01'; current: StateBoard };

/**
 * 乐观锁补丁（TC-FR-09-001）：expectedVersion 落后即拒绝（E-ST-01），返回当前板
 * 供调用方广播最新版；命中则整字段覆盖并 version+1。patch 缺省字段保留原值。
 */
export function applyStatePatch(
  board: StateBoard,
  patch: StatePatch,
  expectedVersion: number,
): StatePatchResult {
  if (board.version !== expectedVersion) {
    return { ok: false, code: 'E-ST-01', current: board };
  }
  const next = StateBoardSchema.parse({
    version: board.version + 1,
    pcs: patch.pcs ?? board.pcs,
    scene: patch.scene ?? board.scene,
    facts: patch.facts ?? board.facts,
    updatedAt: new Date().toISOString(),
  });
  return { ok: true, next };
}
