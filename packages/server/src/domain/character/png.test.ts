import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { extractCardBase64, readCardFromPng, readPngChunks, writeCardToPng } from './png.js';

/**
 * T-M5-02：PNG tEXt chunk 读写（ccv3 规范，TC-FR-08-003）。
 *
 * 夹具是一张真实生成的 1×1 PNG（外部工具产物），因此「写回后仍可被解析」是
 * 对真实字节流的验证，不是自说自话。
 */

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** 独立校验：每个块的类型+数据的 CRC32 必须与文件里记录的 CRC 一致（PNG 规范要求） */
function assertCrcValid(buffer: Buffer): string[] {
  const types: string[] = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('latin1');
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    const recorded = buffer.readUInt32BE(offset + 8 + length);
    expect(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])) >>> 0).toBe(recorded);
    types.push(type);
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  return types;
}

/** 测试侧造块：往 IEND 前塞一个指定关键字的 tEXt 块（用于构造社区 v2 卡形态） */
function appendTextChunk(buffer: Buffer, keyword: string, text: string): Buffer {
  const chunks = readPngChunks(buffer);
  const body = Buffer.concat([
    Buffer.from(keyword, 'latin1'),
    Buffer.from([0]),
    Buffer.from(text, 'latin1'),
  ]);
  const out: Buffer[] = [buffer.subarray(0, 8)];
  for (const chunk of chunks) {
    if (chunk.type === 'IEND') {
      const header = Buffer.alloc(8);
      header.writeUInt32BE(body.length, 0);
      header.write('tEXt', 4, 4, 'latin1');
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from('tEXt', 'latin1'), body])) >>> 0, 0);
      out.push(header, body, crc);
    }
    const header = Buffer.alloc(8);
    header.writeUInt32BE(chunk.data.length, 0);
    header.write(chunk.type, 4, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(
      crc32(Buffer.concat([Buffer.from(chunk.type, 'latin1'), chunk.data])) >>> 0,
      0,
    );
    out.push(header, chunk.data, crc);
  }
  return Buffer.concat(out);
}

describe('readPngChunks', () => {
  it('解析出真实 PNG 的块序列', () => {
    expect(readPngChunks(PNG_1X1).map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
  });

  it('非 PNG 文件抛错（导入流「检测」步据此转成可诊断信息）', () => {
    expect(() => readPngChunks(Buffer.from('{"spec":"chara_card_v3"}'))).toThrow(/不是有效的 PNG/);
  });

  it('块序列截断（缺 IEND）时抛错，不当成可读卡放行', () => {
    expect(() => readPngChunks(PNG_1X1.subarray(0, PNG_1X1.length - 10))).toThrow(/IEND/);
  });
});

describe('ccv3 卡块读写', () => {
  const cardJson = JSON.stringify({ spec: 'chara_card_v3', data: { name: '守秘人' } });

  it('无卡块时返回 null（普通图片不是角色卡）', () => {
    expect(extractCardBase64(PNG_1X1)).toBeNull();
    expect(readCardFromPng(PNG_1X1)).toBeNull();
  });

  it('写入后可读回同一份 JSON（含中文，base64 编码往返无损）', () => {
    const withCard = writeCardToPng(PNG_1X1, cardJson);

    const found = readCardFromPng(withCard);
    expect(found?.keyword).toBe('ccv3');
    expect(found?.json).toBe(cardJson);
  });

  it('写回的 PNG 仍是合规文件：签名在、图像块保留、每个块 CRC 正确', () => {
    const withCard = writeCardToPng(PNG_1X1, cardJson);

    expect(withCard.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    const types = assertCrcValid(withCard);
    expect(types).toContain('IHDR');
    expect(types).toContain('IDAT');
    expect(types.at(-1)).toBe('IEND');
    // 卡块插在 IEND 之前
    expect(types.at(-2)).toBe('tEXt');
  });

  it('重复写入只保留一个 ccv3 块（不累积）', () => {
    let buffer = writeCardToPng(PNG_1X1, cardJson);
    buffer = writeCardToPng(buffer, JSON.stringify({ spec: 'chara_card_v3', data: { name: 'B' } }));

    expect(readPngChunks(buffer).filter((c) => c.type === 'tEXt')).toHaveLength(1);
    expect(JSON.parse(readCardFromPng(buffer)?.json ?? '{}').data.name).toBe('B');
  });

  it('社区 v2 卡的 chara 块可读取（ccv3 优先、chara 回退）', () => {
    const v2Only = appendTextChunk(
      PNG_1X1,
      'chara',
      Buffer.from(cardJson, 'utf8').toString('base64'),
    );
    expect(extractCardBase64(v2Only)?.keyword).toBe('chara');

    // 同时带两个块时以 ccv3 为准
    const both = appendTextChunk(
      writeCardToPng(PNG_1X1, JSON.stringify({ spec: 'chara_card_v3', data: { name: 'V3' } })),
      'chara',
      Buffer.from('{"data":{"name":"V2"}}', 'utf8').toString('base64'),
    );
    expect(readCardFromPng(both)?.keyword).toBe('ccv3');
    expect(JSON.parse(readCardFromPng(both)?.json ?? '{}').data.name).toBe('V3');
  });

  it('卡块内容不是 JSON 文本时如实返回（由导入流判为非法，不静默）', () => {
    const junk = appendTextChunk(
      PNG_1X1,
      'ccv3',
      Buffer.from('not-json', 'utf8').toString('base64'),
    );
    expect(readCardFromPng(junk)?.json).toBe('not-json');
  });
});
