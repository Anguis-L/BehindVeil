import { crc32 } from 'node:zlib';

/**
 * ccv3 PNG 卡读写（T-M5-02，FR-08 / NFR-08）。
 *
 * 规范（chara_card_v3）：卡数据以 **base64(UTF-8 JSON)** 放进 PNG 的 tEXt 块——
 * 关键字 `ccv3` 是 v3，社区 v2 老卡用 `chara`，读取时 v3 优先、v2 回退。
 * 之所以走 base64：tEXt 只保证 Latin-1 安全，中文描述直写会破坏块结构。
 *
 * 实现选择：PNG 块结构（签名 + [长度|类型|数据|CRC32] 序列）足够简单，
 * 自研约百行，换来「零新增依赖」——许可证门禁（NFR-08）不必再为一个解析器审一遍依赖树。
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** ccv3 优先，社区 v2 回退 */
const CARD_KEYWORDS = ['ccv3', 'chara'] as const;
const TEXT_CHUNK_TYPE = 'tEXt';
const IEND_CHUNK_TYPE = 'IEND';

export interface PngChunk {
  type: string;
  data: Buffer;
}

/** tEXt 块数据 = keyword + NUL + text（Latin-1） */
function parseTextChunk(data: Buffer): { keyword: string; text: string } | null {
  const nul = data.indexOf(0);
  if (nul <= 0) return null;
  return {
    keyword: data.subarray(0, nul).toString('latin1'),
    text: data.subarray(nul + 1).toString('latin1'),
  };
}

function buildTextChunk(keyword: string, text: string): Buffer {
  return Buffer.concat([
    Buffer.from(keyword, 'latin1'),
    Buffer.from([0]),
    Buffer.from(text, 'latin1'),
  ]);
}

function buildChunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, 4, 'latin1');
  const crcInput = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput) >>> 0, 0);
  return Buffer.concat([header, data, crc]);
}

/** 不是 PNG（签名不符）或块序列截断都抛错——由导入流的「检测」步转成可诊断信息 */
export function readPngChunks(buffer: Buffer): PngChunk[] {
  if (buffer.length < PNG_SIGNATURE.length || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('不是有效的 PNG 文件（签名不符）');
  }
  const chunks: PngChunk[] = [];
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('latin1');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) throw new Error('PNG 块序列被截断');
    chunks.push({ type, data: buffer.subarray(dataStart, dataEnd) });
    offset = dataEnd + 4; // +CRC
    if (type === IEND_CHUNK_TYPE) break;
  }
  // 没有 IEND 的 PNG 不是完整文件（截断/损坏），不要当可读卡静默放行
  if (chunks.at(-1)?.type !== IEND_CHUNK_TYPE) {
    throw new Error('PNG 缺少 IEND 结束块（文件被截断或已损坏）');
  }
  return chunks;
}

/** 取出嵌入的卡数据（base64 原文，未解码）；没有卡块返回 null */
export function extractCardBase64(buffer: Buffer): { keyword: string; base64: string } | null {
  const chunks = readPngChunks(buffer);
  for (const keyword of CARD_KEYWORDS) {
    for (const chunk of chunks) {
      if (chunk.type !== TEXT_CHUNK_TYPE) continue;
      const parsed = parseTextChunk(chunk.data);
      if (parsed?.keyword === keyword) return { keyword, base64: parsed.text };
    }
  }
  return null;
}

/** 取出嵌入的卡 JSON 文本；没有卡块返回 null，base64/JSON 损坏抛错 */
export function readCardFromPng(buffer: Buffer): { keyword: string; json: string } | null {
  const found = extractCardBase64(buffer);
  if (!found) return null;
  let json: string;
  try {
    json = Buffer.from(found.base64, 'base64').toString('utf8');
  } catch {
    throw new Error(`PNG 内 ${found.keyword} 块的 base64 无法解码`);
  }
  return { keyword: found.keyword, json };
}

/**
 * 把卡 JSON 写进 PNG：移除已有的 ccv3/chara 块，在 IEND 前插入新的 ccv3 块。
 * 只写 ccv3——v1 需求不含「导出给只读 v2 的旧工具」，写 v2 副本属未要求的冗余。
 * 图像数据（IHDR/IDAT/其他辅助块）原样保留，产物可被标准图像工具解析（TC-FR-08-003）。
 */
export function writeCardToPng(buffer: Buffer, cardJson: string): Buffer {
  const chunks = readPngChunks(buffer);
  const kept: PngChunk[] = [];
  for (const chunk of chunks) {
    if (chunk.type !== TEXT_CHUNK_TYPE) {
      kept.push(chunk);
      continue;
    }
    const parsed = parseTextChunk(chunk.data);
    const isCardChunk =
      parsed !== null && (CARD_KEYWORDS as readonly string[]).includes(parsed.keyword);
    if (!isCardChunk) kept.push(chunk);
  }

  const cardChunk = buildChunk(
    TEXT_CHUNK_TYPE,
    buildTextChunk('ccv3', Buffer.from(cardJson, 'utf8').toString('base64')),
  );

  const parts: Buffer[] = [PNG_SIGNATURE];
  let inserted = false;
  for (const chunk of kept) {
    if (chunk.type === IEND_CHUNK_TYPE) {
      parts.push(cardChunk);
      inserted = true;
    }
    parts.push(buildChunk(chunk.type, chunk.data));
  }
  if (!inserted) parts.push(cardChunk); // 无 IEND（罕见）：补在末尾，宁可多写不丢卡
  return Buffer.concat(parts);
}
