import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { io } from 'socket.io-client';
import type { Message } from '@behindveil/shared';

/**
 * T-M1-10：会话 store（进房 → 消息流 → 断线重连）。
 * socket.io-client 与全局 fetch 全部 mock：不触网、不依赖服务端。
 * socket 是 store 模块级变量，故每个用例 vi.resetModules + 动态 import 拿全新模块。
 */

vi.mock('socket.io-client', () => ({ io: vi.fn() }));

interface JoinAckShape {
  ok: boolean;
  roomId?: string;
  memberId?: string;
  role?: string;
  activeSessionId?: string | null;
  lastSeq?: number;
  members?: Array<{ id: string; name: string; role: string }>;
  message?: string;
}

function makeFakeSocket() {
  const handlers = new Map<string, (payload?: unknown) => void>();
  return {
    handlers,
    socket: {
      connected: false,
      emit: vi.fn(),
      on: vi.fn((event: string, cb: (payload?: unknown) => void) => {
        handlers.set(event, cb);
      }),
      off: vi.fn(),
      disconnect: vi.fn(),
    },
  };
}

type Fake = ReturnType<typeof makeFakeSocket>;

let fake: Fake;
let useSessionStore: (typeof import('./session.js'))['useSessionStore'];
const fetchMock =
  vi.fn<(input: string | URL) => Promise<{ ok: boolean; json: () => Promise<unknown> }>>();

const icMsg = (seq: number): Message => ({
  seq,
  ts: '2026-09-25T04:00:00.000Z',
  sessionId: 's_1',
  type: 'ic',
  senderId: 'm_a',
  content: `第 ${seq} 条`,
});

const okAck: JoinAckShape = {
  ok: true,
  roomId: 'room-1',
  memberId: 'm_me',
  role: 'player',
  activeSessionId: 's_1',
  lastSeq: 0,
  members: [{ id: 'm_me', name: '阿珂', role: 'player' }],
};

/** 让 fake socket 对 room:join / session:start 回 ack */
function ackOn(event: string, resp: unknown): void {
  fake.socket.emit.mockImplementation((...args: unknown[]) => {
    const ack = args[2];
    if (args[0] === event && typeof ack === 'function') {
      (ack as (r: unknown) => void)(resp);
    }
  });
}

beforeEach(async () => {
  vi.resetModules();
  fake = makeFakeSocket();
  vi.mocked(io).mockClear();
  vi.mocked(io).mockReturnValue(fake.socket as never);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: async () => [] });
  vi.stubGlobal('fetch', fetchMock);
  setActivePinia(createPinia());
  ({ useSessionStore } = await import('./session.js'));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('join（进房，T-M1-03/08）', () => {
  it('成功：状态转移、REST 拉历史并恢复时间线正序', async () => {
    ackOn('room:join', okAck);
    fetchMock.mockResolvedValue({ ok: true, json: async () => [icMsg(2), icMsg(1)] }); // 接口降序
    const store = useSessionStore();

    await store.join('ABC234', '阿珂', '');

    expect(store.view).toBe('room');
    expect(store.roomId).toBe('room-1');
    expect(store.memberId).toBe('m_me');
    expect(store.role).toBe('player');
    expect(store.activeSessionId).toBe('s_1');
    expect(store.members).toHaveLength(1);
    expect(store.messages.map((m) => m.seq)).toEqual([1, 2]);
    expect(store.maxSeq).toBe(2);

    const payload = fake.socket.emit.mock.calls[0]?.[1] as {
      inviteCode: string;
      hostToken?: string;
    };
    expect(payload.inviteCode).toBe('ABC234');
    expect('hostToken' in payload).toBe(false); // 空 hostToken 不携带
    expect(fetchMock).toHaveBeenCalledWith('/rooms/room-1/messages?limit=50&sessionId=s_1');
  });

  it('hostToken 非空时随 payload 下发', async () => {
    ackOn('room:join', okAck);
    const store = useSessionStore();

    await store.join('ABC234', 'KP', 'host-token-1');

    const payload = fake.socket.emit.mock.calls[0]?.[1] as { hostToken?: string };
    expect(payload.hostToken).toBe('host-token-1');
  });

  it('失败：写入 error、断开连接、视图不变', async () => {
    ackOn('room:join', { ok: false, message: '邀请码无效' });
    const store = useSessionStore();

    await store.join('ZZZZZZ', '阿珂', '');

    expect(store.error).toBe('邀请码无效');
    expect(store.view).toBe('join');
    expect(fake.socket.disconnect).toHaveBeenCalled();
  });

  it('断线重连：携带原 memberId 与已收 lastSeq', async () => {
    ackOn('room:join', okAck);
    const store = useSessionStore();
    store.memberId = 'm_me';
    store.maxSeq = 5;

    await store.join('ABC234', '阿珂', '');

    const payload = fake.socket.emit.mock.calls[0]?.[1] as { memberId?: string; lastSeq?: number };
    expect(payload.memberId).toBe('m_me');
    expect(payload.lastSeq).toBe(5);
  });
});

describe('消息流（ingest 去重 / 名册刷新）', () => {
  it('按 seq 去重：补发与实时流重叠不重复', () => {
    const store = useSessionStore();
    store.ingest([icMsg(1)]);
    store.ingest([icMsg(1), icMsg(2)]);

    expect(store.messages.map((m) => m.seq)).toEqual([1, 2]);
    expect(store.maxSeq).toBe(2);
  });

  it('他人 join 系统消息触发一次名册刷新', async () => {
    const store = useSessionStore();
    store.roomId = 'room-1';
    store.name = '阿珂';
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ activeSessionId: 's_2' }),
    });

    store.ingest([
      {
        seq: 1,
        ts: '2026-09-25T04:00:00.000Z',
        sessionId: 's_1',
        type: 'system',
        subtype: 'join',
        content: '老王 加入了房间',
      },
    ]);
    await vi.waitFor(() => expect(store.activeSessionId).toBe('s_2'));
    expect(fetchMock).toHaveBeenCalledWith('/rooms/room-1');
  });
});

describe('send / startSession / fetchHistory', () => {
  it('空白内容不发送', () => {
    const store = useSessionStore();
    store.send('ic', '   ');
    expect(fake.socket.emit).not.toHaveBeenCalled();
  });

  it('send 走 msg:send', () => {
    const store = useSessionStore();
    store.send('ooc', '你好');
    expect(fake.socket.emit).toHaveBeenCalledWith('msg:send', { type: 'ooc', content: '你好' });
  });

  it('startSession：web 端默认 settings，成功更新 activeSessionId', () => {
    ackOn('session:start', { ok: true, session: { id: 's_new' } });
    const store = useSessionStore();

    store.startSession('mod-疯狂山脉');

    const [event, payload] = fake.socket.emit.mock.calls[0] as [
      string,
      { moduleId: string; settings: Record<string, unknown> },
    ];
    expect(event).toBe('session:start');
    expect(payload.moduleId).toBe('mod-疯狂山脉');
    expect(payload.settings).toMatchObject({ provider: 'openai-compat', temperature: 0.7 });
    expect(store.activeSessionId).toBe('s_new');
  });

  it('startSession 失败：写入 error', () => {
    ackOn('session:start', { ok: false, message: '仅 Host 可开团' });
    const store = useSessionStore();

    store.startSession('mod-1');

    expect(store.error).toBe('仅 Host 可开团');
  });

  it('fetchHistory 失败不打断（实时流仍可用）', async () => {
    const store = useSessionStore();
    store.roomId = 'room-1';
    fetchMock.mockRejectedValue(new Error('network down'));

    await expect(store.fetchHistory()).resolves.toBeUndefined();
    expect(store.messages).toEqual([]);
  });
});

describe('socket 事件接线（connect / disconnect / error:app / reset）', () => {
  it('error:app 格式化为 [code] message', () => {
    const store = useSessionStore();
    store.send('ic', 'x'); // 惰性触发 getSocket，注册事件监听
    fake.socket.emit.mockClear();
    fake.handlers.get('error:app')?.({ code: 'E-ROOM-01', message: '房间已满' });
    expect(store.error).toBe('[E-ROOM-01] 房间已满');
  });

  it('断线且在房间视图 → 标记 connectionLost', () => {
    const store = useSessionStore();
    store.send('ic', 'x');
    store.view = 'room';
    fake.handlers.get('disconnect')?.();
    expect(store.connected).toBe(false);
    expect(store.connectionLost).toBe(true);
  });

  it('重连成功且在房间视图 → 自动重入房并恢复会话', () => {
    ackOn('room:join', { ok: true, activeSessionId: 's_2', members: [] });
    const store = useSessionStore();
    store.send('ic', 'x');
    fake.socket.emit.mockClear();
    store.view = 'room';
    store.memberId = 'm_me';
    store.maxSeq = 7;

    fake.handlers.get('connect')?.();

    const [event, payload] = fake.socket.emit.mock.calls[0] as [string, Record<string, unknown>];
    expect(event).toBe('room:join');
    expect(payload).toMatchObject({ inviteCode: '', name: '', memberId: 'm_me', lastSeq: 7 });
    expect(store.connectionLost).toBe(false);
    expect(store.activeSessionId).toBe('s_2');
  });

  it('reset：断开 socket 并复位状态', () => {
    const store = useSessionStore();
    store.send('ic', 'x'); // 触发 getSocket 创建连接
    store.view = 'room';

    store.reset();

    expect(fake.socket.disconnect).toHaveBeenCalled();
    expect(store.view).toBe('join');
  });
});
