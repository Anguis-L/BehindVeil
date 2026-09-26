import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataLayout, type DataLayout } from '../../adapters/storage/layout.js';
import { appendMessage } from '../../domain/session/messages.js';
import { createRoom } from '../../domain/session/rooms.js';
import { createSession } from '../../domain/session/sessions.js';
import { registerExportRoutes } from './export.js';
import type { Message } from '@behindveil/shared';

/**
 * 导出 REST 出口（T-M6-01/02，FR-12）+ TC-FR-12-003：5000 条消息导出 < 10s。
 * 与 markdown/html 单测互补：这里走真实落盘数据，覆盖鉴权、404、format 分支与规模。
 */

const settings = {
  provider: 'openai-compat',
  model: 'deepseek-chat',
  temperature: 0.7,
  maxHistoryMessages: 40,
  worldBookBudgetTokens: 2000,
  scanDepth: 4,
  contextWindowTokens: 32_768,
  outputReserveTokens: 2_048,
};

let layout: DataLayout;
let app: FastifyInstance;
let secured: FastifyInstance;
let roomId = '';
let sessionId = '';
/** 下载文件名里的日期戳取自会话 startedAt（实现口径），此处同源取用以免跨天必红 */
let sessionStamp = '';
const ADMIN_TOKEN = 'secret-export-789';

const sample: Message[] = [
  {
    seq: 1,
    ts: '2026-09-25T20:00:01.000Z',
    sessionId: 'ses_x',
    type: 'ic',
    senderId: 'm_alice',
    content: '我推开门。',
  },
  {
    seq: 2,
    ts: '2026-09-25T20:00:02.000Z',
    sessionId: 'ses_x',
    type: 'narration',
    streaming: false,
    content: '门后一片漆黑。',
  },
  {
    seq: 3,
    ts: '2026-09-25T20:00:03.000Z',
    sessionId: 'ses_x',
    type: 'dice',
    roll: {
      expr: '1d100<=60',
      rolls: [[45]],
      kept: [45],
      total: 45,
      check: {
        rulebook: 'coc7',
        kind: 'skill',
        target: 60,
        difficulty: 'normal',
        outcome: 'success',
      },
      audit: { seq: '000012', ts: '2026-09-25T20:00:03.000Z', rollId: 'roll-abc-123' },
    },
    hidden: true,
    senderId: 'm_alice',
  },
];

beforeAll(async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'bv-http-export-'));
  layout = createDataLayout(dataDir);

  const room = await createRoom(layout, { name: '导出测试房' });
  roomId = room.id;
  const session = await createSession(layout, roomId, { moduleId: 'the-haunting', settings });
  sessionId = session.id;
  sessionStamp = session.startedAt.slice(0, 10);

  for (const message of sample) {
    await appendMessage(layout, roomId, sessionId, { ...message, sessionId });
  }

  app = Fastify({ logger: false });
  registerExportRoutes(app, { layout, adminToken: undefined });
  await app.ready();

  secured = Fastify({ logger: false });
  registerExportRoutes(secured, { layout, adminToken: ADMIN_TOKEN });
  await secured.ready();
});

/**
 * 只关服务，不递归删临时目录：本文件的规模用例（5000 条）会让清理动作撞上
 * 沙箱的批量删除守卫并挂住钩子，与被测行为无关。目录落在系统临时区，由 OS 回收。
 */
afterAll(async () => {
  await app.close();
  await secured.close();
});

const url = () => `/rooms/${roomId}/sessions/${sessionId}/export`;

describe('导出 REST', () => {
  it('默认导出 Markdown，带下载文件名', async () => {
    const res = await app.inject({ method: 'GET', url: url() });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(String(res.headers['content-disposition'])).toContain(
      `behindveil-${roomId}-${sessionId}-${sessionStamp}.md`,
    );
    expect(res.body).toContain('我推开门。');
  });

  it('format=html 导出染色 HTML', async () => {
    const res = await app.inject({ method: 'GET', url: `${url()}?format=html` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(String(res.headers['content-disposition'])).toContain('.html');
    expect(res.body).toContain('<!DOCTYPE html>');
  });

  it('暗骰照实进入导出物（Host 视角完整版）', async () => {
    const res = await app.inject({ method: 'GET', url: url() });
    expect(res.body).toContain('暗骰');
    expect(res.body).toContain('000012');
  });

  it('非法 format 返回 400', async () => {
    const res = await app.inject({ method: 'GET', url: `${url()}?format=xml` });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'E-ROOM-01' });
  });

  it('房间不存在 / 会话不存在均返回 404', async () => {
    const noRoom = await app.inject({
      method: 'GET',
      url: '/rooms/room_nope/sessions/ses_x/export',
    });
    expect(noRoom.statusCode).toBe(404);

    const noSession = await app.inject({
      method: 'GET',
      url: `/rooms/${roomId}/sessions/ses_nope/export`,
    });
    expect(noSession.statusCode).toBe(404);
  });

  it('管理面令牌启用后，导出端点同口径受保护', async () => {
    const denied = await secured.inject({ method: 'GET', url: url() });
    expect(denied.statusCode).toBe(401);

    const allowed = await secured.inject({
      method: 'GET',
      url: url(),
      headers: { 'x-admin-token': ADMIN_TOKEN },
    });
    expect(allowed.statusCode).toBe(200);
  });

  it('TC-FR-12-003：5000 条消息导出耗时 < 10s', async () => {
    const bulkRoom = await createRoom(layout, { name: '规模房' });
    const bulkSession = await createSession(layout, bulkRoom.id, {
      moduleId: 'the-haunting',
      settings,
    });
    const lines: string[] = [];
    for (let i = 0; i < 5000; i += 1) {
      const seq = i + 1;
      const type = i % 7;
      const base = {
        seq,
        ts: new Date(Date.UTC(2026, 8, 25, 20, 0, i % 60)).toISOString(),
        sessionId: bulkSession.id,
      };
      if (type === 3) {
        lines.push(
          JSON.stringify({
            ...base,
            type: 'dice',
            roll: {
              expr: '1d100<=60',
              rolls: [[(i % 100) + 1]],
              kept: [(i % 100) + 1],
              total: (i % 100) + 1,
              check: {
                rulebook: 'coc7',
                kind: 'skill',
                target: 60,
                difficulty: 'normal',
                outcome: 'success',
              },
              audit: {
                seq: String(i).padStart(6, '0'),
                ts: base.ts,
                rollId: `roll-${i}`,
              },
            },
            hidden: false,
            senderId: 'm_alice',
          }),
        );
      } else if (type === 5) {
        lines.push(
          JSON.stringify({
            ...base,
            type: 'ooc',
            senderId: 'm_alice',
            content: '场外',
            visibility: 'all',
          }),
        );
      } else {
        lines.push(
          JSON.stringify({ ...base, type: 'ic', senderId: 'm_alice', content: `第 ${seq} 句` }),
        );
      }
    }
    await writeFile(
      layout.messagesFile(bulkRoom.id, bulkSession.id),
      `${lines.join('\n')}\n`,
      'utf8',
    );

    const bulkUrl = `/rooms/${bulkRoom.id}/sessions/${bulkSession.id}/export`;
    const t0 = Date.now();
    const md = await app.inject({ method: 'GET', url: bulkUrl });
    const html = await app.inject({ method: 'GET', url: `${bulkUrl}?format=html` });
    const elapsed = Date.now() - t0;

    expect(md.statusCode).toBe(200);
    expect(html.statusCode).toBe(200);
    expect(md.body).toContain('第 5000 句');
    expect(html.body).toContain('第 5000 句');
    expect(elapsed).toBeLessThan(10_000);
  }, 30_000);
});
