import type { ExportEntry, ExportInput, JudgeLevel } from './render.js';
import { hpTextOf, statTextOf, toExportEntries } from './render.js';

/**
 * 染色 HTML 日志导出（T-M6-02，FR-12 / TDD §8；TC-FR-12-002）。
 *
 * 自包含单文件：样式内联，不引外部字体与脚本——产物可直接双击打开、可长期归档，
 * 也符合自托管场景「数据不出本机」的定位。
 *
 * 配色来源 packages/web/src/styles/tokens.css（设计基线，改设计先改那里再同步本文件）：
 * 判定色 --bv-judge-* 只用于表达检定结果；其余分类靠**版式**（字体/字阶/徽章）区分，
 * 不靠配色——六级色阶一旦挪作他用，语义就失效了。
 *
 * 两条安全不变式：
 *  1. 全部文本经 escapeHtml 转义（消息内容可能含 <script> 等注入串，导出物会被浏览器打开）；
 *  2. 输入不含世界书与 prompt trace，kpOnly 条目内容在结构上不可能进入产物
 *     （回归护栏见 html.test.ts 的全文检索断言）。
 */

/** 判定语义色，与 tokens.css --bv-judge-* 逐一对应 */
const JUDGE_COLORS: Record<JudgeLevel, string> = {
  critical: '#70d4c7',
  extreme: '#80b069',
  hard: '#b8a84f',
  regular: '#c79640',
  fail: '#c26640',
  fumble: '#b2402e',
  none: '#6e6659',
};

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderDice(entry: ExportEntry): string {
  const dice = entry.dice;
  if (!dice) return '';
  const color = JUDGE_COLORS[dice.level];
  const badge = dice.hidden ? `${escapeHtml(dice.outcome)} · 暗骰` : escapeHtml(dice.outcome);
  return [
    `<div class="dice" style="--judge:${color}">`,
    '  <div class="dice-head">',
    `    <code class="dice-expr">${escapeHtml(dice.expr)}</code>`,
    `    <span class="dice-total">${dice.total}</span>`,
    `    <span class="dice-badge">${badge}</span>`,
    '  </div>',
    '  <div class="audit">',
    `    <span>原始骰值 <code>${escapeHtml(dice.rolls)}</code></span>`,
    `    <span>保留 <code>${escapeHtml(dice.kept)}</code></span>`,
    `    <span>流水号 <code>${escapeHtml(dice.auditSeq)}</code></span>`,
    `    <span>rollId <code>${escapeHtml(dice.rollId)}</code></span>`,
    '  </div>',
    '</div>',
  ].join('\n');
}

function renderSnapshot(entry: ExportEntry): string {
  const snap = entry.snapshot;
  if (!snap) return '';
  const rows = snap.pcs
    .map(
      (pc) =>
        `        <tr><td>${escapeHtml(pc.playerName)}</td><td>${escapeHtml(pc.memberName)}</td>` +
        `<td class="num">${hpTextOf(pc)}</td><td class="num">${statTextOf(pc.san)}</td>` +
        `<td class="num">${statTextOf(pc.mp)}</td><td class="num">${statTextOf(pc.luck)}</td>` +
        `<td>${escapeHtml(pc.conditions.join('、') || '—')}</td></tr>`,
    )
    .join('\n');
  const facts = snap.facts.map((f) => `      <li>${escapeHtml(f)}</li>`).join('\n');

  return [
    '    <div class="snapshot">',
    `      <div class="snap-scene"><strong>${escapeHtml(snap.sceneName || '（未命名）')}</strong>` +
      `<span class="muted">${escapeHtml(snap.sceneTime || '—')}</span></div>`,
    ...(snap.sceneDesc !== ''
      ? [`      <div class="snap-desc">${escapeHtml(snap.sceneDesc)}</div>`]
      : []),
    ...(rows !== ''
      ? [
          '      <table>',
          '        <thead><tr><th>调查员</th><th>成员</th><th>HP</th><th>SAN</th><th>MP</th><th>幸运</th><th>状态</th></tr></thead>',
          '        <tbody>',
          rows,
          '        </tbody>',
          '      </table>',
        ]
      : []),
    ...(facts !== '' ? ['      <ul class="facts">', facts, '      </ul>'] : []),
    '    </div>',
  ].join('\n');
}

function renderEntry(entry: ExportEntry): string {
  const tag = entry.tag !== null ? `<span class="tag">${escapeHtml(entry.tag)}</span>` : '';
  const head =
    `      <div class="meta"><span class="seq">#${entry.seq}</span>` +
    `<span class="time">${escapeHtml(entry.time)}</span>` +
    `<span class="speaker">${escapeHtml(entry.speaker)}</span>` +
    `<span class="cat">${escapeHtml(entry.categoryLabel)}</span>${tag}</div>`;

  const parts: string[] = [`    <article class="msg msg-${entry.category}">`, head];
  if (entry.body !== '') {
    parts.push(`      <div class="body">${escapeHtml(entry.body)}</div>`);
  }
  const dice = renderDice(entry);
  if (dice !== '') parts.push(`      ${dice}`);
  const snapshot = renderSnapshot(entry);
  if (snapshot !== '') parts.push(snapshot);
  parts.push('    </article>');
  return parts.join('\n');
}

const STYLES = `
:root {
  --bg: #14120d; --surface: #1c1712; --elevated: #241f17; --sunken: #1a160f; --inset: #17130e;
  --text: #f2ebdb; --text-2: #a89c8a; --text-3: #6e6659;
  --accent: #c79640;
  --line: rgba(245, 235, 219, 0.09); --line-2: rgba(245, 235, 219, 0.2);
  --font-ui: 'Sarasa Gothic SC', 'Inter', system-ui, sans-serif;
  --font-narrative: 'Noto Serif SC', 'Source Serif 4', Georgia, serif;
  --font-mono: 'JetBrains Mono', ui-monospace, monospace;
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 32px 16px 64px; background: var(--bg); color: var(--text);
  font-family: var(--font-ui); font-size: 15px; line-height: 1.7;
}
.wrap { max-width: 820px; margin: 0 auto; }
header { border-bottom: 1px solid var(--line-2); padding-bottom: 20px; margin-bottom: 28px; }
h1 { font-size: 22px; font-weight: 600; margin: 0 0 12px; letter-spacing: 0.02em; }
dl { display: grid; grid-template-columns: 88px 1fr; gap: 4px 12px; margin: 0; font-size: 13px; }
dt { color: var(--text-3); }
dd { margin: 0; color: var(--text-2); }
.synopsis {
  margin-top: 12px; padding: 10px 14px; background: var(--inset);
  border-left: 2px solid var(--accent); color: var(--text-2); font-size: 14px;
}
.msg { margin: 0 0 20px; padding: 10px 0 10px 14px; border-left: 2px solid transparent; }
.meta { display: flex; flex-wrap: wrap; gap: 10px; align-items: baseline; font-size: 12px; color: var(--text-3); }
.seq { font-family: var(--font-mono); }
.speaker { color: var(--accent); font-weight: 600; }
.cat { padding: 1px 7px; border: 1px solid var(--line-2); border-radius: 999px; }
.tag { padding: 1px 7px; border-radius: 999px; background: var(--sunken); color: var(--text-2); }
.body { margin-top: 6px; white-space: pre-wrap; word-break: break-word; }
.msg-ooc { border-left-color: var(--line-2); }
.msg-ooc .body { color: var(--text-2); font-style: italic; }
.msg-system { border-left-color: var(--line); }
.msg-system .body { color: var(--text-3); font-size: 13px; }
.msg-narration { border-left-color: var(--accent); }
.msg-narration .body {
  font-family: var(--font-narrative); font-size: 17px; line-height: 29px; color: var(--text);
}
.msg-state_snapshot { border-left-color: var(--line-2); }
.dice {
  margin-top: 8px; padding: 12px 16px; border-radius: 12px; background: var(--elevated);
  background-image: linear-gradient(to right, var(--judge) 0 6px, transparent 6px);
  background-repeat: no-repeat;
}
.dice-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.dice-expr { font-family: var(--font-mono); font-size: 13px; color: var(--text-2); }
.dice-total { font-family: var(--font-mono); font-size: 24px; font-weight: 600; color: var(--judge); }
.dice-badge {
  font-size: 12px; padding: 2px 9px; border-radius: 999px;
  color: var(--judge); border: 1px solid currentColor;
}
.audit {
  display: flex; flex-wrap: wrap; gap: 4px 16px; margin-top: 10px; padding-top: 8px;
  border-top: 1px solid var(--line); font-size: 11px; color: var(--text-3);
  font-family: var(--font-mono);
}
.snapshot {
  margin-top: 8px; padding: 12px 16px; border-radius: 12px; background: var(--inset);
}
.snap-scene { display: flex; gap: 10px; align-items: baseline; font-size: 14px; }
.snap-desc { margin-top: 6px; color: var(--text-2); font-size: 14px; white-space: pre-wrap; }
.muted { color: var(--text-3); font-size: 12px; }
table { width: 100%; margin-top: 10px; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--line); }
th { color: var(--text-3); font-weight: 500; }
td.num { font-family: var(--font-mono); text-align: right; }
.facts { margin: 10px 0 0; padding-left: 20px; font-size: 13px; color: var(--text-2); }
.empty { color: var(--text-3); font-size: 14px; }
@media (max-width: 600px) { body { padding: 20px 10px 40px; } dl { grid-template-columns: 72px 1fr; } }
`.trim();

export function renderHtml(input: ExportInput): string {
  const entries = toExportEntries(input);
  const { session } = input;
  const title = `${input.roomName} · 跑团日志`;

  const meta: Array<[string, string]> = [
    ['会话', session.id],
    ['模组', session.moduleRef || '—'],
    ['开始', session.startedAt],
    ['结束', session.endedAt ?? '（进行中）'],
    ['消息数', String(entries.length)],
    ['导出时间', new Date().toISOString()],
  ];

  const body =
    entries.length === 0
      ? '    <p class="empty">（本会话暂无消息）</p>'
      : entries.map(renderEntry).join('\n');

  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    `  <title>${escapeHtml(title)}</title>`,
    '  <style>',
    STYLES,
    '  </style>',
    '</head>',
    '<body>',
    '  <div class="wrap">',
    '    <header>',
    `      <h1>${escapeHtml(title)}</h1>`,
    '      <dl>',
    ...meta.map(
      ([key, value]) => `        <dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`,
    ),
    '      </dl>',
    ...(session.synopsis !== ''
      ? [`      <div class="synopsis">剧情梗概：${escapeHtml(session.synopsis)}</div>`]
      : []),
    '    </header>',
    '    <main>',
    body,
    '    </main>',
    '  </div>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
