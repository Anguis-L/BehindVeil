import {
  CharacterCardV3Schema,
  type CardImportResult,
  type CardImportStep,
  type CharacterCardV2,
  type CharacterCardV3,
} from '@behindveil/shared';
import { readCardFromPng } from './png.js';

/**
 * 三步导入流（T-M5-03，SDD §3.2 M5 行 / TC-FR-08-005）。
 *
 * 检测（spec 识别） → 转换（v2 → v3 映射） → 验证（Schema + 必填）。
 * 任一步失败都返回 `step` 定位 + 可读原因，而不是笼统一句「导入失败」。
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type Detected = 'ccv3' | 'ccv2';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(step: CardImportStep, message: string): CardImportResult {
  return { ok: false, step, code: 'E-CARD-01', message };
}

/**
 * 检测：ccv3 看 spec 字面量；v2 兼容两种形态——带 `spec: 'chara_card_v2'`，
 * 或社区常见的「无 spec 扁平卡 / 字段压在 data 里」（此时靠特征字段判定）。
 */
export function detectCardSpec(input: unknown): Detected | null {
  if (!isRecord(input)) return null;
  const spec = input['spec'];
  if (spec === 'chara_card_v3') return 'ccv3';
  if (spec === 'chara_card_v2') return 'ccv2';

  const nested = isRecord(input['data']) ? input['data'] : {};
  const flat = { ...nested, ...input }; // 顶层优先
  const hits = ['name', 'description', 'first_mes', 'personality'].filter(
    (key) => typeof flat[key] === 'string',
  );
  // 至少两个特征字段，避免把任意 JSON 误判成卡
  return hits.length >= 2 ? 'ccv2' : null;
}

function pickString(
  v2: CharacterCardV2,
  key:
    | 'name'
    | 'description'
    | 'personality'
    | 'scenario'
    | 'first_mes'
    | 'mes_example'
    | 'creator_notes',
): string {
  const nested = isRecord(v2.data) ? (v2.data as Record<string, unknown>) : {};
  const value = v2[key] ?? nested[key];
  return typeof value === 'string' ? value : '';
}

/**
 * 转换：v2 → v3。description 合并 personality（ccv3 没有 personality 字段，
 * 而 KP 卡的「行为准则 + 判定规则」正是这两者合起来的语义，见 SDD §3.3）。
 * 缺 name 无法建卡 → 归 convert 步失败。
 */
export function convertV2ToV3(
  v2: CharacterCardV2,
): { ok: true; card: unknown } | { ok: false; message: string } {
  const name = pickString(v2, 'name').trim();
  if (name === '') return { ok: false, message: 'v2 卡缺少 name 字段，无法确定角色名' };

  const description = [pickString(v2, 'description'), pickString(v2, 'personality')]
    .filter((part) => part.trim() !== '')
    .join('\n\n');
  if (description === '') {
    return { ok: false, message: 'v2 卡缺少 description / personality，无法生成 KP 行为准则' };
  }

  const nested = isRecord(v2.data) ? (v2.data as Record<string, unknown>) : {};
  const extensions = isRecord(v2['extensions'])
    ? v2['extensions']
    : isRecord(nested['extensions'])
      ? (nested['extensions'] as Record<string, unknown>)
      : {};
  const characterBook = v2['character_book'] ?? nested['character_book'];

  return {
    ok: true,
    card: {
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: {
        name,
        description,
        scenario: pickString(v2, 'scenario'),
        first_mes: pickString(v2, 'first_mes'),
        mes_example: pickString(v2, 'mes_example'),
        ...(characterBook !== undefined ? { character_book: characterBook } : {}),
        extensions,
      },
    },
  };
}

/** 验证 + 组装结果；校验失败归 validate 步，并把首个问题字段带进信息里 */
function validateCard(card: unknown, source: Detected): CardImportResult {
  const parsed = CharacterCardV3Schema.safeParse(card);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue ? issue.path.join('.') : '(根)';
    return fail('validate', `字段 ${where} 校验失败：${issue?.message ?? '不合法'}`);
  }
  return { ok: true, source, card: parsed.data };
}

/** 三步导入流入口（JSON 对象形态）。PNG 走 `importCardBytes` */
export function importCardObject(input: unknown): CardImportResult {
  const detected = detectCardSpec(input);
  if (detected === null) {
    return fail('detect', '无法识别角色卡格式：既不是 chara_card_v3，也不像 v2 卡');
  }
  if (detected === 'ccv3') return validateCard(input, 'ccv3');

  const converted = convertV2ToV3(input as CharacterCardV2);
  if (!converted.ok) return fail('convert', converted.message);
  return validateCard(converted.card, 'ccv2');
}

/** PNG 卡 → 取出内嵌 JSON → 走三步导入流；JSON 卡则直接按文本解析 */
export function importCardBytes(bytes: Buffer, fileName: string): CardImportResult {
  let raw: string;
  try {
    if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
      const found = readCardFromPng(bytes);
      if (found === null) {
        return fail('detect', `${fileName}：PNG 内没有嵌入角色卡数据（缺少 ccv3/chara 文本块）`);
      }
      raw = found.json;
    } else {
      raw = bytes.toString('utf8');
    }
  } catch (err) {
    return fail('detect', `${fileName}：读取失败——${(err as Error).message}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return fail('detect', `${fileName}：卡数据不是合法 JSON`);
  }
  return importCardObject(input);
}

/** 导出为 ccv3 JSON 文本（roundtrip 用；缩进 2 便于手编，与世界书口径一致） */
export function exportCardJson(card: CharacterCardV3): string {
  return JSON.stringify(card, null, 2);
}
