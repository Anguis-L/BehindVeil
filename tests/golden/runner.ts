/**
 * 黄金用例框架（TDD §5.1 / 测试文档 §6.2，TC-NFR-09-001）。
 *
 * 约定：每个用例一个目录，含
 *   input.json   —— PipelineInput 快照（消息列表会用 shared 的 MessageSchema 校验，防快照漂移）
 *   expect.json  —— 期望产物，支持六种断言：
 *      stageNames   阶段序列（M0 骨架级）
 *      messageRoles 最终 messages 的 role 序列
 *      messages     最终 messages 全文（M2 起的主力断言，走 diff 机制）
 *      contains     最终 messages 拼接文本必须包含的子串
 *      notContains  最终 messages 拼接文本不得包含的子串（T-M2-07：裁剪/不注入类用例）
 *      traceDetails 按阶段全名对 detail 做「期望是实际的子集」断言（数组须全等），
 *                   钉住 trace 契约（如 S4 droppedUids、S7 回退轮数）
 *
 * 行为变更必须显式改用例（TDD §5.1）——改 expect.json 就是改契约。
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPrompt } from '../../packages/server/dist/pipeline/index.js';
import { createHeuristicTokenizer } from '../../packages/server/dist/pipeline/tokenizer.js';
import { MessageSchema } from '../../packages/shared/dist/message.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const CASES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cases');

export interface GoldenExpectation {
  stageNames?: string[];
  messageRoles?: string[];
  messages?: unknown;
  contains?: string[];
  notContains?: string[];
  traceDetails?: Record<string, unknown>;
}

export interface GoldenCase {
  name: string;
  dir: string;
  input: unknown;
  expectation: GoldenExpectation;
}

export interface GoldenResult {
  name: string;
  ok: boolean;
  diffs: string[];
}

export interface GoldenActual {
  stageNames: string[];
  messageRoles: string[];
  messages: Array<{ role: string; content: string }>;
  text: string;
}

/** 逐行 diff：返回人类可读的差异列表，空数组表示一致。 */
export function diffLines(expected: unknown, actual: unknown): string[] {
  const e = JSON.stringify(expected, null, 2)?.split('\n') ?? [];
  const a = JSON.stringify(actual, null, 2)?.split('\n') ?? [];
  const diffs: string[] = [];
  for (let i = 0; i < Math.max(e.length, a.length); i += 1) {
    const expectedLine = e[i] ?? '<缺失>';
    const actualLine = a[i] ?? '<缺失>';
    if (expectedLine !== actualLine) {
      diffs.push(`第 ${i + 1} 行  期望: ${expectedLine}  实际: ${actualLine}`);
    }
  }
  return diffs;
}

function diffLists(label: string, expected: string[], actual: string[]): string[] {
  if (expected.length !== actual.length || expected.some((v, i) => v !== actual[i])) {
    return [`${label} 不一致  期望: ${JSON.stringify(expected)}  实际: ${JSON.stringify(actual)}`];
  }
  return [];
}

/** 子集匹配：期望对象/数组的每个值都必须在实际值中出现（数组退化为全等，保证确定性） */
function isSubset(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((value, i) => isSubset(value, actual[i]))
    );
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false;
    const record = actual as Record<string, unknown>;
    return Object.entries(expected).every(
      ([key, value]) => key in record && isSubset(value, record[key]),
    );
  }
  return expected === actual;
}

export async function loadGoldenCases(casesDir: string = CASES_DIR): Promise<GoldenCase[]> {
  const entries = await readdir(casesDir, { withFileTypes: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  return Promise.all(
    dirs.map(async (name) => {
      const dir = path.join(casesDir, name);
      const [input, expectation] = await Promise.all([
        readFile(path.join(dir, 'input.json'), 'utf8').then(JSON.parse) as Promise<unknown>,
        readFile(path.join(dir, 'expect.json'), 'utf8').then(
          JSON.parse,
        ) as Promise<GoldenExpectation>,
      ]);
      return { name, dir, input, expectation };
    }),
  );
}

export function runGoldenCaseSync(goldenCase: GoldenCase): GoldenResult {
  const diffs: string[] = [];
  const input = goldenCase.input as { messages?: unknown[] } & Parameters<typeof buildPrompt>[0];

  // 快照校验：输入消息必须符合共享契约，否则用例本身就是坏的
  for (const [index, message] of (input.messages ?? []).entries()) {
    const parsed = MessageSchema.safeParse(message);
    if (!parsed.success) {
      diffs.push(`input.messages[${index}] 不符合 MessageSchema：${parsed.error.message}`);
    }
  }

  const trace = buildPrompt(input, createHeuristicTokenizer());
  const messages = (trace.messages ?? []) as Array<{ role: string; content: string }>;
  const actual: GoldenActual = {
    stageNames: trace.stages.map((stage) => stage.name.slice(0, 2)),
    messageRoles: messages.map((message) => message.role),
    messages,
    text: messages.map((message) => message.content).join('\n'),
  };

  const expectation = goldenCase.expectation;
  if (expectation.stageNames) {
    diffs.push(...diffLists('阶段序列', expectation.stageNames, actual.stageNames));
  }
  if (expectation.messageRoles) {
    diffs.push(...diffLists('messages role 序列', expectation.messageRoles, actual.messageRoles));
  }
  if (expectation.messages) {
    diffs.push(...diffLines(expectation.messages, actual.messages));
  }
  for (const needle of expectation.contains ?? []) {
    if (!actual.text.includes(needle)) {
      diffs.push(`最终 messages 缺少内容：${needle}`);
    }
  }
  for (const needle of expectation.notContains ?? []) {
    if (actual.text.includes(needle)) {
      diffs.push(`最终 messages 不应包含：${needle}`);
    }
  }
  for (const [stageName, expectedDetail] of Object.entries(expectation.traceDetails ?? {})) {
    const stage = trace.stages.find((s) => s.name === stageName);
    if (!stage) {
      diffs.push(`trace 缺少阶段：${stageName}`);
      continue;
    }
    if (!isSubset(expectedDetail, stage.detail)) {
      diffs.push(
        `阶段 ${stageName} detail 不满足期望子集\n  期望(子集): ${JSON.stringify(expectedDetail)}\n  实际: ${JSON.stringify(stage.detail)}`,
      );
    }
  }

  return { name: goldenCase.name, ok: diffs.length === 0, diffs };
}

export const PROJECT_ROOT = ROOT;
