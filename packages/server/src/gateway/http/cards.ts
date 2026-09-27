import { CardUploadSchema, type CardEntry } from '@behindveil/shared';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { DataLayout } from '../../adapters/storage/layout.js';
import { deleteCard, listCards, readCard, saveCard } from '../../domain/character/library.js';

/**
 * 卡库管理 REST（T-M5-09，FR-08）。
 *
 * 鉴权沿用管理面口径（决议 ②，与 rooms.ts 管理组一致）：AIDLE_ADMIN_TOKEN 设置后
 * 需 `X-Admin-Token` 头。上传走 base64 JSON 而非 multipart——省一个依赖，
 * 且 NFR-08 的许可证门禁不必为 multipart 插件再过一遍。
 *
 * 卡片文件在 `data/cards/` 下原样保存（PNG/JSON 均不重编码），备份 = 复制目录。
 */

export interface CardRouteDeps {
  layout: DataLayout;
  /** 决议 ②：来自 AIDLE_ADMIN_TOKEN；undefined 表示管理面不启用门禁 */
  adminToken: string | undefined;
}

function firstIssueMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  const path = issue ? issue.path.join('.') : '';
  return issue ? `${path || '(根)'}: ${issue.message}` : '请求体不合法';
}

export function registerCardRoutes(app: FastifyInstance, deps: CardRouteDeps): void {
  const { layout, adminToken } = deps;

  const requireAdmin = async (
    req: { headers: Record<string, unknown> },
    reply: { code(statusCode: number): { send(payload: unknown): unknown } },
  ): Promise<unknown> => {
    if (adminToken === undefined) return undefined;
    if (req.headers['x-admin-token'] !== adminToken) {
      return reply.code(401).send({ code: 'E-CARD-01', message: '管理面需要 X-Admin-Token 令牌' });
    }
    return undefined;
  };

  app.post('/cards', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = CardUploadSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'E-CARD-01', message: firstIssueMessage(parsed.error) });
    }
    const saved = await saveCard(
      layout,
      parsed.data.fileName,
      Buffer.from(parsed.data.contentBase64, 'base64'),
    );
    if (!saved.ok) {
      // 三步流的失败定位（检测/转换/验证）直接透出，便于用户知道卡哪里不对
      return reply.code(400).send({
        code: 'E-CARD-01',
        message: `导入失败（${saved.step}）：${saved.message}`,
      });
    }
    return reply.code(201).send(saved.library.entry);
  });

  app.get('/cards', { preHandler: requireAdmin }, async () => {
    const cards = await listCards(layout);
    const entries: CardEntry[] = cards.map((c) => c.entry);
    return entries;
  });

  app.get('/cards/:cardId', { preHandler: requireAdmin }, async (req, reply) => {
    const { cardId } = req.params as { cardId: string };
    const found = await readCard(layout, cardId);
    if (!found) {
      return reply.code(404).send({ code: 'E-CARD-01', message: '角色卡不存在' });
    }
    return found.card;
  });

  app.delete('/cards/:cardId', { preHandler: requireAdmin }, async (req, reply) => {
    const { cardId } = req.params as { cardId: string };
    const removed = await deleteCard(layout, cardId);
    if (!removed) {
      return reply.code(404).send({ code: 'E-CARD-01', message: '角色卡不存在' });
    }
    return reply.code(204).send();
  });
}
