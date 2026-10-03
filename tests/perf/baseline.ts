import { readFile, writeFile } from 'node:fs/promises';
import { arch, cpus, platform } from 'node:os';

/**
 * NFR-10 性能基线（T-M10-00，设计 §1 宣言「先量后动」/ §5.1 预算账户）。
 *
 * baseline.json 记录指标值 + 机器指纹。对比仅在指纹一致（同一台机器）时执行：
 * 绝对耗时跨硬件不可比，CI（ubuntu）对本地（win32）记录的基线跳过对比只告警，
 * 门禁语义 = 「基线所属机器上的回归闸」，不是跨机排行榜。
 *
 * 指标口径（五基准，设计 §5.2 / 测试文档 TC-NFR-05 系列；统计量为 G-M10 校准）：
 * - scan_batch_ms      扫描批量耗时（200 次 × 5 批取最小）    相对 ≤ 基线×1.2
 * - pipeline_batch_ms  管线批量耗时（100 次 × 5 批取最小）    相对 ≤ 基线×1.2
 * - first_token_p50_ms 首 token 服务端开销 p50（MockLlm 回环） 相对 ≤ 基线×1.2，且劣化 ≤ floor
 * - soak_msgs_total    soak 短版消息总量（3 端 × 限速）       相对 ≥ 基线×0.8（跌超 20% 且超 floor 才红灯）
 * - soak_rss_growth_mb soak RSS 增量                          绝对预算 < 100MB（v1 口径）
 *
 * 扫描/管线用批量总耗时而非设计原文的分位数：亚毫秒量级下逐次分位数同机波动
 * 可达 10–40%（GC/调度噪声），批量 + min-of-batches 把噪声摊平且可重复（T-M10-04
 * 实测达标）。p95/p50 的「绝对预算」半边（扫描 <50ms / 管线 <100ms / 首 token <1s）
 * 由 tests/bench/nfr05-bench.test.ts 与测试文档 TC-NFR-05 系列把守；本表负责
 * 「基线+20%」相对回归半边——两半合起来即设计 §5.1 的 max() 预算形。
 */

export interface MachineFingerprint {
  platform: string;
  arch: string;
  cpuModel: string;
  cpuCount: number;
  nodeMajor: number;
}

export interface PerfSpec {
  key: string;
  label: string;
  unit: string;
  /** relative = 对基线相对比（higher_is_better 按方向各自实现）；budgetMax = 绝对上限 */
  mode: 'relative' | 'budgetMax';
  /** relative 容差（0.2 = 劣化超 20% 红灯，NFR-10） */
  tolerance?: number;
  /** relative 指标的绝对劣化豁免（与指标同单位；小值噪声豁免，G-M10 校准） */
  floor?: number;
  /** 指标变差的方向：lower = 值变大为劣化；higher = 值变小为劣化 */
  higherIsWorse: boolean;
  /** budgetMax 模式的上限 */
  limit?: number;
  /**
   * relative 模式的绝对预算（higher-is-worse 时生效）：
   * 阈值 = max(absoluteLimit, 基线×(1+tolerance))——设计 §5.1 的 max() 预算形。
   * 基线远低于绝对预算时由绝对预算主导（环境噪声不误红），基线涨上来后相对半边接管。
   */
  absoluteLimit?: number;
}

export const PERF_SPECS: PerfSpec[] = [
  {
    key: 'scan_batch_ms',
    label: '扫描批量耗时（200 次）',
    unit: 'ms',
    mode: 'relative',
    tolerance: 0.2,
    higherIsWorse: true,
    absoluteLimit: 50,
  },
  {
    key: 'pipeline_batch_ms',
    label: '管线批量耗时（100 次）',
    unit: 'ms',
    mode: 'relative',
    tolerance: 0.2,
    higherIsWorse: true,
    absoluteLimit: 100,
  },
  {
    key: 'first_token_p50_ms',
    label: '首 token 服务端开销 p50（MockLlm）',
    unit: 'ms',
    mode: 'relative',
    tolerance: 0.2,
    floor: 2,
    higherIsWorse: true,
  },
  {
    key: 'soak_msgs_total',
    label: 'soak 短版消息总量',
    unit: '条',
    mode: 'relative',
    tolerance: 0.2,
    floor: 3,
    higherIsWorse: false,
  },
  {
    key: 'soak_rss_growth_mb',
    label: 'soak RSS 增量',
    unit: 'MB',
    mode: 'budgetMax',
    higherIsWorse: true,
    limit: 100,
  },
  {
    key: 'backup_fsync_p99_delta_ms',
    label: '热备 fsync p99 增量',
    unit: 'ms',
    mode: 'budgetMax',
    higherIsWorse: true,
    limit: 5,
  },
];

export interface BaselineFile {
  specVersion: 1;
  recordedAt: string;
  machine: MachineFingerprint;
  metrics: Record<string, number>;
}

export interface MetricCompare {
  key: string;
  label: string;
  baseline: number;
  current: number;
  ok: boolean;
  detail: string;
}

export interface CompareOutcome {
  /** true = 因机器不一致跳过对比（CI 场景，门禁放行但必须告警） */
  skipped: boolean;
  results: MetricCompare[];
}

export function machineFingerprint(): MachineFingerprint {
  return {
    platform: platform(),
    arch: arch(),
    cpuModel: (cpus()[0]?.model ?? 'unknown').trim(),
    cpuCount: cpus().length,
    nodeMajor: Number(process.versions.node.split('.')[0]),
  };
}

export function fingerprintsMatch(a: MachineFingerprint, b: MachineFingerprint): boolean {
  return (
    a.platform === b.platform &&
    a.arch === b.arch &&
    a.cpuModel === b.cpuModel &&
    a.cpuCount === b.cpuCount &&
    a.nodeMajor === b.nodeMajor
  );
}

export async function loadBaseline(file: string): Promise<BaselineFile | null> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  return JSON.parse(raw) as BaselineFile;
}

export async function saveBaseline(file: string, metrics: Record<string, number>): Promise<void> {
  const baseline: BaselineFile = {
    specVersion: 1,
    recordedAt: new Date().toISOString(),
    machine: machineFingerprint(),
    metrics,
  };
  await writeFile(file, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
}

/**
 * 逐指标对比。相对模式：劣化方向超出 tolerance 即红灯（floorMs 提供绝对噪声豁免）；
 * budgetMax：绝对上限。baseline 指标缺失 = 基线不完整，红灯（基线由 perf:record 生成，不该缺）。
 */
export function compareMetrics(
  baseline: BaselineFile,
  current: Record<string, number>,
): MetricCompare[] {
  return PERF_SPECS.map((spec) => {
    const baseValue = baseline.metrics[spec.key];
    const cur = current[spec.key];

    if (
      baseValue === undefined ||
      cur === undefined ||
      Number.isNaN(baseValue) ||
      Number.isNaN(cur)
    ) {
      return {
        key: spec.key,
        label: spec.label,
        baseline: baseValue ?? Number.NaN,
        current: cur ?? Number.NaN,
        ok: false,
        detail: '指标缺失（基线或本轮测量不完整）',
      };
    }

    if (spec.mode === 'budgetMax') {
      const limit = spec.limit ?? Number.POSITIVE_INFINITY;
      return {
        key: spec.key,
        label: spec.label,
        baseline: baseValue,
        current: cur,
        ok: cur <= limit,
        detail: `${cur.toFixed(1)}${spec.unit} ≤ 预算 ${limit}${spec.unit}`,
      };
    }

    const tolerance = spec.tolerance ?? 0.2;
    // 预算阈值 = max(绝对预算, 基线×(1+容差))——设计 §5.1 的 max() 预算形：
    // 基线远低于绝对预算时由绝对预算主导，基线涨上来后相对半边接管
    const limit = spec.higherIsWorse
      ? Math.max(spec.absoluteLimit ?? 0, baseValue * (1 + tolerance))
      : baseValue * (1 + tolerance);
    const floor = spec.floor ?? 0;
    const withinRelative = spec.higherIsWorse ? cur <= limit : cur >= baseValue * (1 - tolerance);
    const withinFloor =
      !withinRelative && (spec.higherIsWorse ? cur - baseValue <= floor : baseValue - cur <= floor);
    const ok = withinRelative || withinFloor;
    const direction = spec.higherIsWorse ? '升' : '降';
    return {
      key: spec.key,
      label: spec.label,
      baseline: baseValue,
      current: cur,
      ok,
      detail: `基线 ${baseValue.toFixed(2)}${spec.unit} → 本轮 ${cur.toFixed(2)}${spec.unit}（阈值 ${limit.toFixed(2)}${spec.unit}${spec.absoluteLimit ? ` = max(绝对 ${spec.absoluteLimit}, 基线+${(tolerance * 100).toFixed(0)}%)` : ''}${floor > 0 ? `，绝对豁免 ${floor}${spec.unit}` : ''}）${ok ? (withinFloor ? `：${direction}幅超限但落在绝对豁免内` : '') : `：${direction}幅超限`}`,
    };
  });
}
