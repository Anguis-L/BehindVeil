import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * T-M1-04：Socket 事件契约（TDD §4.1/§4.2 + docs/socketio-asyncapi.yaml）。
 * 对应 TC-FR-02-004（双向 Zod：出入站 payload 都要能被校验）。
 *
 * 契约先行：本文件在 `packages/shared/src/protocol.ts` 落地**之前**就写好。
 * 为避免在未落地时打断 `pnpm verify`（CI 首跑刚全绿），采用「契约未就绪则整组跳过」：
 * 动态加载 shared 构建产物，取不到就把整个 describe 置为 skipped；
 * 一旦 protocol.ts 落地，用例自动激活。跳过状态在测试输出里可见（↓），不会静默消失。
 */

const PROTOCOL_DIST = fileURLToPath(
  new URL('../../packages/shared/dist/protocol.js', import.meta.url),
);

const protocol = (await import(/* @vite-ignore */ pathToFileURL(PROTOCOL_DIST).href).catch(
  () => null,
)) as Record<string, unknown> | null;

interface AnySchema {
  parse(input: unknown): unknown;
  safeParse(input: unknown): { success: boolean };
}

const schema = (name: string): AnySchema => {
  const found = protocol?.[name];
  if (!found) throw new Error(`protocol.ts 未导出 ${name}`);
  return found as AnySchema;
};

const suite = protocol ? describe : describe.skip;

const asRecord = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

const SETTINGS = {
  provider: 'openai-compat',
  model: 'deepseek-chat',
  temperature: 0.8,
  maxHistoryMessages: 40,
  worldBookBudgetTokens: 2000,
  scanDepth: 4,
};

const MESSAGE = {
  seq: 1,
  ts: '2026-09-25T00:00:00.000Z',
  sessionId: 'ses_1',
  type: 'ic',
  senderId: 'm_alice',
  content: '我翻开书桌的抽屉。',
};

const STATE_BOARD = {
  version: 1,
  pcs: {},
  scene: { name: '书房', time: '1924-03-12 夜', publicDesc: '壁炉噼啪作响' },
  facts: [],
  updatedAt: '2026-09-25T00:00:00.000Z',
};

suite('protocol.ts 契约（T-M1-04）', () => {
  it('契约模块已落地（否则本组用例跳过）', () => {
    expect(protocol).not.toBeNull();
  });

  describe('客户端 → 服务端（TDD §4.1）', () => {
    it('room:join：邀请码定长 6，wantRole 不得为 host（D-02）', () => {
      const s = schema('RoomJoinSchema');

      expect(
        s.safeParse({ inviteCode: 'A7K2Q9', name: '爱丽丝', wantRole: 'player' }).success,
      ).toBe(true);
      expect(
        s.safeParse({ inviteCode: 'A7K2Q9', name: '小明', wantRole: 'observer' }).success,
      ).toBe(true);
      expect(s.safeParse({ inviteCode: 'A7K2', name: '爱丽丝' }).success).toBe(false);
      expect(s.safeParse({ name: '爱丽丝' }).success).toBe(false);
      expect(s.safeParse({ inviteCode: 'A7K2Q9', name: '爱丽丝', wantRole: 'host' }).success).toBe(
        false,
      );
      // 决议（2026-09-25）：建房响应返回 hostToken，进房时出示即成为 Host。
      // zod 默认会剥掉未声明键，因此必须断言「字段被声明且解析后保留」——仅不报错是空断言。
      const withToken = s.parse({ inviteCode: 'A7K2Q9', name: '爱丽丝', hostToken: 'tok_abc123' });
      expect(asRecord(withToken)['hostToken']).toBe('tok_abc123');
    });

    it('room:join：断线重连字段 memberId / lastSeq 透传（T-M1-08）', () => {
      const s = schema('RoomJoinSchema');

      const parsed = s.parse({
        inviteCode: 'A7K2Q9',
        name: '爱丽丝',
        memberId: 'm_1',
        lastSeq: 42,
      });

      expect(asRecord(parsed)['memberId']).toBe('m_1');
      expect(asRecord(parsed)['lastSeq']).toBe(42);
      expect(s.safeParse({ inviteCode: 'A7K2Q9', name: 'x', lastSeq: -1 }).success).toBe(false);
    });

    it('session:start：settings 必填（docs 口径）', () => {
      const s = schema('SessionStartSchema');

      expect(s.safeParse({ moduleId: 'mountains-of-madness', settings: SETTINGS }).success).toBe(
        true,
      );
      expect(s.safeParse({ moduleId: 'mountains-of-madness' }).success).toBe(false);
    });

    it('msg:send：type 仅 ic/ooc，targetId 可选', () => {
      const s = schema('MsgSendSchema');

      expect(s.safeParse({ type: 'ic', content: '我翻开抽屉。' }).success).toBe(true);
      expect(s.safeParse({ type: 'ooc', content: '这人不太对劲', targetId: 'm_bob' }).success).toBe(
        true,
      );
      expect(s.safeParse({ type: 'dice', content: 'x' }).success).toBe(false);
      expect(s.safeParse({ type: 'ic' }).success).toBe(false);
    });

    it('ai:invoke：空载荷合法（无必填字段）', () => {
      const s = schema('AiInvokeSchema');

      expect(s.safeParse({}).success).toBe(true);
      expect(s.safeParse({ reason: '请描述我进入帐篷后看到的东西' }).success).toBe(true);
    });

    it('dice:roll：expr 必填，hidden/label 可选', () => {
      const s = schema('DiceRollSchema');

      expect(s.safeParse({ expr: '1d100<=60', label: '翻查书桌·侦查' }).success).toBe(true);
      expect(s.safeParse({ expr: '1d100', hidden: true, label: 'NPC 的隐藏察觉' }).success).toBe(
        true,
      );
      expect(s.safeParse({ hidden: true }).success).toBe(false);
    });

    it('state:update：patch 与 expectedVersion 必填，版本号非负', () => {
      const s = schema('StateUpdateSchema');

      expect(s.safeParse({ patch: { facts: ['门被锁'] }, expectedVersion: 12 }).success).toBe(true);
      expect(s.safeParse({ patch: {} }).success).toBe(false);
      expect(s.safeParse({ patch: {}, expectedVersion: -1 }).success).toBe(false);
    });

    it('state:snapshot：空载荷', () => {
      const s = schema('StateSnapshotSchema');

      expect(s.safeParse({}).success).toBe(true);
    });

    it('kp:previewPrompt：seq 可选整数', () => {
      const s = schema('KpPreviewPromptSchema');

      expect(s.safeParse({}).success).toBe(true);
      expect(s.safeParse({ seq: 5 }).success).toBe(true);
      expect(s.safeParse({ seq: 'five' }).success).toBe(false);
    });
  });

  describe('服务端 → 客户端（TDD §4.2，出站同样须过 Schema）', () => {
    it('msg:broadcast 承载完整 Message', () => {
      const s = schema('MsgBroadcastSchema');

      expect(s.safeParse({ msg: MESSAGE }).success).toBe(true);
      expect(s.safeParse({ msg: { seq: 1 } }).success).toBe(false);
      expect(s.safeParse({}).success).toBe(false);
    });

    it('narration:delta / narration:done', () => {
      expect(schema('NarrationDeltaSchema').safeParse({ seq: 3, delta: '你' }).success).toBe(true);
      expect(schema('NarrationDeltaSchema').safeParse({ seq: 3 }).success).toBe(false);
      expect(schema('NarrationDoneSchema').safeParse({ seq: 3 }).success).toBe(true);
    });

    it('state:broadcast 承载状态板', () => {
      const s = schema('StateBroadcastSchema');

      expect(s.safeParse({ stateBoard: STATE_BOARD }).success).toBe(true);
      expect(s.safeParse({ stateBoard: { version: 1 } }).success).toBe(false);
    });

    it('kp:promptPreview 承载 PipelineTrace', () => {
      const s = schema('KpPromptPreviewSchema');

      expect(s.safeParse({ pipeline: { stages: [], messages: [] } }).success).toBe(true);
      expect(s.safeParse({ pipeline: {} }).success).toBe(false);
    });

    it('error:app 的 code 必须落在错误码表内', () => {
      const s = schema('ErrorAppSchema');

      expect(s.safeParse({ code: 'E-LLM-01', message: 'KP 沉吟中…（重试）' }).success).toBe(true);
      expect(s.safeParse({ code: 'E-FOO-99', message: 'x' }).success).toBe(false);
      expect(s.safeParse({ code: 'E-DICE-01' }).success).toBe(false);
    });
  });
});

const hasWhitelist =
  protocol !== null && 'CLIENT_EVENTS' in protocol && 'isClientEvent' in protocol;
const whitelistSuite = hasWhitelist ? describe : describe.skip;

whitelistSuite('事件白名单（TDD §8：非白名单事件即断连）', () => {
  it('入站白名单覆盖八个客户端事件', () => {
    const events = protocol?.['CLIENT_EVENTS'] as readonly string[];

    for (const name of [
      'room:join',
      'session:start',
      'msg:send',
      'ai:invoke',
      'dice:roll',
      'state:update',
      'state:snapshot',
      'kp:previewPrompt',
    ]) {
      expect(events).toContain(name);
    }
  });

  it('出站事件不得被当作入站事件接受', () => {
    const isClientEvent = protocol?.['isClientEvent'] as (name: string) => boolean;

    expect(isClientEvent('room:join')).toBe(true);
    expect(isClientEvent('msg:broadcast')).toBe(false);
    expect(isClientEvent('narration:delta')).toBe(false);
    expect(isClientEvent('__proto__')).toBe(false);
  });
});
