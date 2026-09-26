import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { RollCheckSchema, type RollAudit } from '@behindveil/shared';
import { JsonlStore } from '../../adapters/storage/jsonl-store.js';
import type { DataLayout } from '../../adapters/storage/layout.js';

/**
 * 骰子审计流水（T-M4-01，TDD §3.5/§6、NFR-04；复现语义按决议 D-04）。
 *
 * 全局单文件追加 `data/logs/audit-dice.jsonl`——每颗服务端掷出的骰子都在此留痕，
 * 与广播给谁无关（暗骰也照记，隐藏的是广播范围，不是凭据）。
 *
 * - `seq`：全局单调流水号，进程重启后从文件尾部恢复续写（追加语义，容忍尾部坏行）；
 * - `rollId`：本次掷骰标识（CSPRNG 生成）。D-04 决议：CSPRNG 无种子、不可重放，
 *   故「复现」= 由流水里的 expr + rolls 重算 kept/total/check 是否一致（见 tools/audit-replay）。
 *   字段名取 rollId 而非 TDD v1 的 engineSeedId，避免暗示存在可回放的种子。
 *
 * 写路径不变式（WAP 同源）：`record()` 返回时该行已 fsync，调用方据此「先落审计、后广播」。
 */
export const DiceAuditEntrySchema = z.object({
  seq: z.string(),
  ts: z.string(),
  rollId: z.string(),
  roomId: z.string(),
  sessionId: z.string(),
  /** 掷骰者 memberId；AI 检定骰（引擎代掷）为 null */
  actor: z.string().nullable(),
  /** 暗骰标记：仅记录广播范围，不影响审计完整性 */
  hidden: z.boolean(),
  expr: z.string(),
  rolls: z.array(z.array(z.number())),
  kept: z.array(z.number()),
  total: z.number(),
  check: RollCheckSchema.nullable(),
});
export type DiceAuditEntry = z.infer<typeof DiceAuditEntrySchema>;

/** 落账输入：seq/ts/rollId 由审计器分配 */
export type DiceAuditInput = Omit<DiceAuditEntry, 'seq' | 'ts' | 'rollId'>;

export interface DiceAuditor {
  /** 落账一次掷骰，返回待写入 RollResult.audit 的审计字段 */
  record(input: DiceAuditInput): Promise<RollAudit>;
  /** 全量读取（复现校验器消费）：Schema 不符的行计为坏行，不抛错 */
  readAll(): Promise<{ entries: DiceAuditEntry[]; badLines: number }>;
  close(): Promise<void>;
}

export interface DiceAuditorOptions {
  /** 测试注入：固定 rollId 序列 */
  newRollId?: () => string;
}

/** 流水号宽度：零填充保证字典序与数值序一致（超过 6 位自然扩展） */
const SEQ_WIDTH = 6;

export function createDiceAuditor(layout: DataLayout, opts: DiceAuditorOptions = {}): DiceAuditor {
  const store = new JsonlStore(layout.auditDiceFile);
  const newRollId = opts.newRollId ?? randomUUID;
  /** 懒初始化：首次落账时从文件尾部恢复，避免启动时无谓 IO */
  let counter: number | null = null;
  /** 全局写串行：seq 分配与写盘同序，跨房间并发掷骰也不会撞号 */
  let tail: Promise<unknown> = Promise.resolve();

  async function writeOne(input: DiceAuditInput): Promise<RollAudit> {
    if (counter === null) counter = await readLastSeq(store);
    counter += 1;
    const seq = String(counter).padStart(SEQ_WIDTH, '0');
    const ts = new Date().toISOString();
    const rollId = newRollId();
    await store.append({ seq, ts, rollId, ...input } satisfies DiceAuditEntry);
    return { seq, ts, rollId };
  }

  return {
    record(input: DiceAuditInput): Promise<RollAudit> {
      // 前序失败不阻塞后续（与网关串行队列同风格）
      const next = tail.then(
        () => writeOne(input),
        () => writeOne(input),
      );
      tail = next.catch(() => undefined);
      return next;
    },

    async readAll(): Promise<{ entries: DiceAuditEntry[]; badLines: number }> {
      const { records, badLines } = await store.readAll();
      const entries: DiceAuditEntry[] = [];
      let bad = badLines;
      for (const record of records) {
        const parsed = DiceAuditEntrySchema.safeParse(record);
        if (parsed.success) entries.push(parsed.data);
        else bad += 1;
      }
      return { entries, badLines: bad };
    },

    close(): Promise<void> {
      return store.close();
    },
  };
}

/**
 * 恢复流水号：追加文件语义上「最后一条可解析行」即最大值；
 * 从后向前回溯可容忍崩溃留下的尾部撕裂行（NFR-06 同口径）。
 */
async function readLastSeq(store: JsonlStore): Promise<number> {
  const { records } = await store.readAll();
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const parsed = DiceAuditEntrySchema.safeParse(records[i]);
    if (!parsed.success) continue;
    const value = Number(parsed.data.seq);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}
