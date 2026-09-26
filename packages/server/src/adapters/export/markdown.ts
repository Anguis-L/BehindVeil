import type { ExportEntry, ExportInput } from './render.js';
import { toExportEntries } from './render.js';

/**
 * Markdown 日志导出（T-M6-01，FR-12；TC-FR-12-001）。
 *
 * 六类消息全覆盖，骰子记录必含审计五要素：骰式 / 原始骰值 / 合计 / 判定 / 流水号
 * （外加 rollId，便于与 data/logs/audit-dice.jsonl 逐条对账）。
 *
 * 纯函数、无 IO：输入来自消息仓库，输出交给调用方落盘或走 HTTP 响应。
 * 正文不做 Markdown 转义——导出物是给人读与归档的日志，保真优先于排版。
 */

function quoteBody(body: string): string {
  if (body === '') return '';
  return body
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function renderDice(entry: ExportEntry): string {
  const dice = entry.dice;
  if (!dice) return '';
  const hidden = dice.hidden ? '（暗骰）' : '';
  return [
    `- **骰式** \`${dice.expr}\``,
    `- **原始骰值** ${dice.rolls}`,
    `- **保留** ${dice.kept}`,
    `- **合计** **${dice.total}**`,
    `- **判定** ${dice.outcome}${hidden}`,
    `- **流水号** \`${dice.auditSeq}\` · rollId \`${dice.rollId}\``,
  ].join('\n');
}

function renderSnapshot(entry: ExportEntry): string {
  const snap = entry.snapshot;
  if (!snap) return '';
  const lines: string[] = [];
  lines.push(`- **场景** ${snap.sceneName || '（未命名）'} ｜ **时间** ${snap.sceneTime || '—'}`);
  if (snap.sceneDesc !== '') lines.push(`- **现场描述** ${snap.sceneDesc}`);
  if (snap.pcs.length > 0) {
    lines.push('');
    lines.push('| 调查员 | 成员 | HP | SAN | MP | 幸运 | 状态 |');
    lines.push('|---|---|---:|---:|---:|---:|---|');
    for (const pc of snap.pcs) {
      lines.push(
        `| ${pc.playerName} | ${pc.memberName} | ${pc.hp} | ${pc.san} | ${pc.mp} | ${pc.luck} | ${pc.conditions.join('、') || '—'} |`,
      );
    }
  }
  if (snap.facts.length > 0) {
    lines.push('');
    lines.push('**已确立事实**');
    for (const fact of snap.facts) lines.push(`- ${fact}`);
  }
  return lines.join('\n');
}

function renderEntry(entry: ExportEntry): string {
  const head = `[${entry.seq}] ${entry.time} · ${entry.speaker} · ${entry.categoryLabel}`;
  const title = `### ${head}${entry.tag ? ` · ${entry.tag}` : ''}`;
  const blocks: string[] = [title, ''];

  const body = quoteBody(entry.body);
  if (body !== '') blocks.push(body, '');

  const dice = renderDice(entry);
  if (dice !== '') blocks.push(dice, '');

  const snapshot = renderSnapshot(entry);
  if (snapshot !== '') blocks.push(snapshot, '');

  return blocks.join('\n');
}

export function renderMarkdown(input: ExportInput): string {
  const entries = toExportEntries(input);
  const { session } = input;
  const endedAt = session.endedAt ?? '（进行中）';

  const header: string[] = [
    `# ${input.roomName} · 跑团日志`,
    '',
    `- **会话** \`${session.id}\``,
    `- **模组** ${session.moduleRef || '—'}`,
    `- **开始** ${session.startedAt}`,
    `- **结束** ${endedAt}`,
    `- **消息数** ${entries.length}`,
    `- **导出时间** ${new Date().toISOString()}`,
  ];
  if (session.synopsis !== '') {
    header.push('', `> **剧情梗概** ${session.synopsis}`);
  }
  header.push('', '---', '');

  if (entries.length === 0) {
    header.push('_（本会话暂无消息）_', '');
    return header.join('\n');
  }

  const body = entries.map(renderEntry).join('\n');
  return `${header.join('\n')}${body}`;
}
