/**
 * redact()（T-M0-05，NFR-03 / TDD §7、§8）：日志、错误、预览、导出输出前的密钥过滤。
 * 覆盖 TC-NFR-03-001 的多形态：header / body / query / 错误堆栈 / 环境变量默认密钥。
 *
 * 两种策略叠加：
 *  1) 键名命中敏感模式（authorization / api_key / token / secret / password…，大小写不敏感）→ 值替换 '***'
 *  2) 字符串值（含堆栈、URL）中出现密钥字面量 → 字面量替换 '***'
 *
 * 纯函数：不修改入参。显式密钥之外的默认密钥源为环境变量 AIDLE_LLM_KEY。
 */
const SENSITIVE_KEY_RE = /(authorization|api[-_]?key|apikey|token|secret|password)/i;
const MASK = '***';

export function redact(value: unknown, secrets?: Array<string | undefined>): unknown {
  const explicit = (secrets ?? []).filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  );
  const envKey = process.env['AIDLE_LLM_KEY'];
  const literals = envKey ? [...explicit, envKey] : explicit;

  const seen = new WeakSet<object>();
  const maskText = (text: string): string => {
    let out = text;
    for (const secret of literals) out = out.replaceAll(secret, MASK);
    return out;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return maskText(v);
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) return '[Circular]';
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(v)) {
      out[key] = SENSITIVE_KEY_RE.test(key) ? MASK : walk(child);
    }
    return out;
  };
  return walk(value);
}
