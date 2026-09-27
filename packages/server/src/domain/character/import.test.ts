import { describe, expect, it } from 'vitest';
import type { CharacterCardV3 } from '@behindveil/shared';
import { detectCardSpec, exportCardJson, importCardBytes, importCardObject } from './import.js';
import { writeCardToPng } from './png.js';

/**
 * T-M5-01/03：ccv3 导入导出与三步导入流（TC-FR-08-001 / 002 / 005）。
 * 失败分支必须能定位到「检测 / 转换 / 验证」哪一步。
 */

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const ccv3 = {
  spec: 'chara_card_v3',
  spec_version: '3.0',
  data: {
    name: '守秘人',
    description: '你是守秘人：只叙述，不宣告判定结果。',
    scenario: '深夜书房',
    first_mes: '灯亮了。',
    mes_example: '',
    extensions: { aidle: { rulebook: 'coc7' } },
  },
};

/** 社区 v2 卡：扁平形态 + 带 personality（ccv3 没有该字段，转换时并入 description） */
const ccv2 = {
  name: '调查员·阿珂',
  description: '瘦高的女子，右手有旧伤。',
  personality: '谨慎、话少、不信神。',
  scenario: '1924 年的伦敦',
  first_mes: '「我不确定该不该告诉你。」',
  mes_example: '',
  extensions: { aidle: { rulebook: 'coc7' } },
};

describe('detectCardSpec（第一步：检测）', () => {
  it('ccv3 与 v2 均识别；无关 JSON 判为 null', () => {
    expect(detectCardSpec(ccv3)).toBe('ccv3');
    expect(detectCardSpec({ ...ccv2, spec: 'chara_card_v2' })).toBe('ccv2');
    expect(detectCardSpec(ccv2)).toBe('ccv2'); // 无 spec 的社区扁平卡
    expect(detectCardSpec({})).toBeNull();
    expect(detectCardSpec(null)).toBeNull();
    expect(detectCardSpec([1, 2])).toBeNull();
  });

  it('字段压在 data 里的 v2 双层形态也能识别', () => {
    expect(detectCardSpec({ data: ccv2 })).toBe('ccv2');
  });
});

describe('importCardObject（三步导入流）', () => {
  it('ccv3 合法卡导入成功', () => {
    const result = importCardObject(ccv3);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe('ccv3');
      expect(result.card.data.name).toBe('守秘人');
    }
  });

  it('v2 卡经转换导入成功：personality 并入 description，其余字段映射到位', () => {
    const result = importCardObject(ccv2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe('ccv2');
      expect(result.card.data.name).toBe('调查员·阿珂');
      expect(result.card.data.description).toContain('右手有旧伤');
      expect(result.card.data.description).toContain('谨慎、话少');
      expect(result.card.data.scenario).toBe('1924 年的伦敦');
      expect(result.card.data.extensions.aidle?.rulebook).toBe('coc7');
    }
  });

  // TC-FR-08-005：三个失败分支分别定位到步
  it('检测失败：无法识别的格式 → step=detect', () => {
    const result = importCardObject({ hello: 'world' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.step).toBe('detect');
  });

  it('转换失败：识别为 v2 但缺 name → step=convert（信息点名缺哪个字段）', () => {
    // 两个特征字段命中 → 判为 v2；但没名字，转不出 ccv3
    const result = importCardObject({ description: '有描述', personality: '有性格' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.step).toBe('convert');
      expect(result.message).toContain('name');
    }
  });

  it('验证失败：ccv3 缺必填字段 → step=validate（信息带字段路径）', () => {
    const result = importCardObject({ spec: 'chara_card_v3', data: { name: '无描述卡' } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.step).toBe('validate');
      expect(result.message).toContain('data.description');
    }
  });
});

describe('导出与 roundtrip（TC-FR-08-002）', () => {
  it('导入→导出→再导入：语义等价，extensions 与社区字段都不丢', () => {
    const communityCard = {
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: {
        name: '带扩展的社区卡',
        description: 'd',
        scenario: 's',
        first_mes: 'f',
        mes_example: '',
        // 我们不消费的社区标准字段：导出必须原样带回
        personality: 'p',
        creator_notes: '作者备注',
        tags: ['恐怖', '推理'],
        extensions: { aidle: { rulebook: 'coc7' }, fav: true, world: '伦敦' },
      },
    };

    const first = importCardObject(communityCard);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const json = exportCardJson(first.card as CharacterCardV3);
    const second = importCardObject(JSON.parse(json));
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.card).toEqual(first.card);
    expect(second.card.data.extensions.fav).toBe(true);
    expect(second.card.data.personality).toBe('p');
    expect(second.card.data.tags).toEqual(['恐怖', '推理']);
  });
});

describe('importCardBytes（PNG / JSON 双形态）', () => {
  it('PNG 内嵌 ccv3 卡可导入', () => {
    const png = writeCardToPng(PNG_1X1, JSON.stringify(ccv3));
    const result = importCardBytes(png, 'keeper.png');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.card.data.name).toBe('守秘人');
  });

  it('PNG 里没有卡数据 → detect 步失败并点名文件', () => {
    const result = importCardBytes(PNG_1X1, 'no-card.png');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.step).toBe('detect');
      expect(result.message).toContain('no-card.png');
    }
  });

  it('JSON 卡文本可直接导入', () => {
    const result = importCardBytes(Buffer.from(JSON.stringify(ccv2), 'utf8'), 'pc.json');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.source).toBe('ccv2');
  });

  it('非 JSON 文本 → detect 步失败', () => {
    const result = importCardBytes(Buffer.from('这不是卡', 'utf8'), 'broken.json');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.step).toBe('detect');
  });
});
