import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDataLayout, type DataLayout } from '../adapters/storage/layout.js';
import { JsonStore } from '../adapters/storage/json-store.js';
import { appendMessage } from '../domain/session/messages.js';
import { createRoom } from '../domain/session/rooms.js';
import { createSession } from '../domain/session/sessions.js';
import { buildPreviewTrace } from './preview.js';

/**
 * KP prompt 预览单测（T-M2-05，FR-13）：从落盘状态组装 PipelineInput 跑完整管线。
 * 覆盖：默认 KP 卡与 COC7 速查、房间级手编世界书命中（D-08）、synopsis 注入（D-01）、
 * 指定 seq 的时点预览（TC-FR-13-002）、世界书校验失败拒绝。
 */

const settings = {
  provider: 'openai-compat',
  model: 'deepseek-chat',
  temperature: 0.7,
  maxHistoryMessages: 2,
  worldBookBudgetTokens: 2000,
  scanDepth: 4,
  contextWindowTokens: 32_768,
  outputReserveTokens: 2_048,
};

let dataDir: string;
let layout: DataLayout;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'bv-preview-'));
  layout = createDataLayout(dataDir);
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

async function seedRoom(): Promise<{ roomId: string; sessionId: string }> {
  const room = await createRoom(layout, { name: '预览房' });
  const session = await createSession(layout, room.id, { moduleId: 'mod-1', settings });
  return { roomId: room.id, sessionId: session.id };
}

async function appendIc(
  roomId: string,
  sessionId: string,
  seq: number,
  content: string,
): Promise<void> {
  await appendMessage(layout, roomId, sessionId, {
    seq,
    ts: '2026-09-25T00:00:00.000Z',
    sessionId,
    type: 'ic',
    senderId: 'mem_1',
    content,
  });
}

describe('buildPreviewTrace（FR-13）', () => {
  it('从落盘状态组装完整管线：默认 KP 卡 + COC7 速查 + 消息历史', async () => {
    const { roomId, sessionId } = await seedRoom();
    await appendIc(roomId, sessionId, 1, '我进入宅邸。');

    const trace = await buildPreviewTrace(layout, roomId, sessionId);

    expect(trace.stages).toHaveLength(7);
    const system = trace.messages[0]?.content ?? '';
    expect(system).toContain('守秘人（KP）');
    expect(system).toContain('COC7');
    const user = trace.messages[1]?.content ?? '';
    expect(user).toContain('我进入宅邸。');
  });

  it('房间级手编世界书参与扫描（D-08 载入链路）', async () => {
    const { roomId, sessionId } = await seedRoom();
    await mkdir(path.join(dataDir, 'rooms', roomId), { recursive: true });
    await writeFile(
      layout.worldbookFile(roomId),
      JSON.stringify({
        entries: [
          {
            uid: 1,
            key: ['宅邸'],
            keysecondary: [],
            selectiveLogic: 0,
            content: '宅邸的镜子是通往异界的门。',
            position: 'after_char',
            order: 0,
            constant: false,
            disabled: false,
          },
        ],
      }),
      'utf8',
    );
    await appendIc(roomId, sessionId, 1, '我推开宅邸大门。');

    const trace = await buildPreviewTrace(layout, roomId, sessionId);

    expect(trace.stages[2]?.detail).toMatchObject({ hitUids: [1] });
    expect(trace.messages[0]?.content).toContain('通往异界的门');
  });

  it('超窗时注入 Host 手编 synopsis（决议 D-01）', async () => {
    const { roomId, sessionId } = await seedRoom();
    for (let seq = 1; seq <= 3; seq += 1)
      await appendIc(roomId, sessionId, seq, `第 ${seq} 条对话`);
    // D-01：Host 直接手编 session.json 的 synopsis 字段
    const sessionFile = layout.sessionFile(roomId, sessionId);
    const raw = (await new JsonStore(sessionFile).read()) as Record<string, unknown>;
    await new JsonStore(sessionFile).write({ ...raw, synopsis: '此前：调查员们在码头汇合。' });

    const trace = await buildPreviewTrace(layout, roomId, sessionId);

    const user = trace.messages[1]?.content ?? '';
    expect(user).toContain('【剧情梗概】\n此前：调查员们在码头汇合。');
    expect(user).not.toContain('第 1 条对话');
    expect(user).toContain('第 3 条对话');
  });

  it('指定 seq 的时点预览（TC-FR-13-002）：仅取 seq ≤ 指定值的消息', async () => {
    const { roomId, sessionId } = await seedRoom();
    for (let seq = 1; seq <= 3; seq += 1)
      await appendIc(roomId, sessionId, seq, `第 ${seq} 条对话`);

    const trace = await buildPreviewTrace(layout, roomId, sessionId, { seq: 2 });

    const user = trace.messages[1]?.content ?? '';
    expect(user).toContain('第 2 条对话');
    expect(user).not.toContain('第 3 条对话');
  });

  it('世界书校验失败 → 抛错（载入时拦截，错误带 uid 定位）', async () => {
    const { roomId, sessionId } = await seedRoom();
    await mkdir(path.join(dataDir, 'rooms', roomId), { recursive: true });
    await writeFile(
      layout.worldbookFile(roomId),
      JSON.stringify({
        entries: [
          {
            uid: 1,
            key: ['x'],
            keysecondary: [],
            selectiveLogic: 0,
            content: '',
            position: 'at_depth',
            order: 0,
            constant: false,
            disabled: false,
          },
        ],
      }),
      'utf8',
    );

    await expect(buildPreviewTrace(layout, roomId, sessionId)).rejects.toThrow('uid=1');
  });

  it('会话不存在 → 抛错', async () => {
    await expect(buildPreviewTrace(layout, 'room-x', 'ses-x')).rejects.toThrow('会话不存在');
  });
});
