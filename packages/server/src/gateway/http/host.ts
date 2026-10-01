import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { GatewayHandle } from '../socket.js';

/**
 * Host 转让/副 Host REST（T-M8-06，FR-26，设计 §5.5「先契约后实现」）。
 *
 * 契约清单（施工期定稿，docs/API.md + openapi.yaml 同步回写）：
 * - `POST /rooms/:roomId/host-transfer`，body `{ hostToken, toMemberId }`
 *   → 200 `{ memberId }`。鉴权 = 当前 hostToken（Host 自助操作，不走 X-Admin-Token）。
 *   校验：房间存在 / token 匹配 / 目标成员存在且在线 / 非观察者 / 非现任 Host。
 *   效果：members.json 角色换位；hostToken 轮换（旧 token 失效）；room.hostAuth='member'；
 *   在线 presence 升降级；全房 notice 广播。错误 400 E-ROOM-01，token 不匹配 401。
 * - `PUT /rooms/:roomId/co-host`，body `{ hostToken, memberId }`（memberId 为 null 即撤销）
 *   → 200 `{ memberId }`（撤销时 `{ memberId: null }`）。校验同上（另加：非现任 Host）。
 *   效果：room.coHostMemberId 标记/清空；notice 广播。撤销不要求目标在线。
 *
 * 安全口径（契约清单备注）：hostAuth='member' 后，Host 重连身份锚定 members.json
 * 角色标记 + memberId——memberId 与 hostToken 同为客户端持有凭据，泄露面等价；
 * 未转让房间维持 v1 口径（hostAuth='token'，重连必须出示 token）。
 *
 * 网关句柄经 `deps.gateway()` 惰性取得（REST 路由注册先于 attachGateway，句柄后到）；
 * 在线状态/presence 在网关内存态，落盘部分由网关内部完成。
 */

const HostTransferSchema = z.object({
  hostToken: z.string().min(1),
  toMemberId: z.string().min(1),
});

const CoHostSchema = z.object({
  hostToken: z.string().min(1),
  /** null = 撤销副 Host */
  memberId: z.string().min(1).nullable(),
});

export interface HostRouteDeps {
  gateway: () => GatewayHandle;
}

export function registerHostRoutes(app: FastifyInstance, deps: HostRouteDeps): void {
  const { gateway } = deps;

  app.post('/rooms/:roomId/host-transfer', async (req, reply) => {
    const { roomId } = req.params as { roomId: string };
    const parsed = HostTransferSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'E-ROOM-01', message: '请求体不合法' });
    }
    const result = await gateway().transferHost(
      roomId,
      parsed.data.hostToken,
      parsed.data.toMemberId,
    );
    if (!result.ok) {
      return reply.code(result.message === 'hostToken 不匹配' ? 401 : 400).send(result);
    }
    return reply.code(200).send({ memberId: result.memberId });
  });

  app.put('/rooms/:roomId/co-host', async (req, reply) => {
    const { roomId } = req.params as { roomId: string };
    const parsed = CoHostSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'E-ROOM-01', message: '请求体不合法' });
    }
    const result = await gateway().setCoHost(roomId, parsed.data.hostToken, parsed.data.memberId);
    if (!result.ok) {
      return reply.code(result.message === 'hostToken 不匹配' ? 401 : 400).send(result);
    }
    return reply.code(200).send({ memberId: parsed.data.memberId });
  });
}
