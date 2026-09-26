/**
 * `.r` 骰式输入解析（T-M4-05，FR-06/14）。
 *
 * 玩家在输入框直接敲 `.r 1d100<=60` 即掷骰，`.rh 1d100` 为暗骰（仅自己与 KP 可见，D-10）。
 * 抽成纯函数便于单测：不碰 DOM、不碰 socket。
 * 骰式本身是否合法由服务端判定（唯一权威），前端只负责识别意图并原样上送。
 */

export interface DiceCommand {
  expr: string;
  hidden: boolean;
}

export type ParsedInput =
  { kind: 'dice'; expr: string; hidden: boolean } | { kind: 'message'; content: string };

/** `.r` / `.rh`，后面可跟骰式；`.r` 单独使用时按跑团惯例补 1d100 */
const DICE_COMMAND = /^\.(r|rh)(?:\s+([\s\S]*))?$/;

export const DEFAULT_DICE_EXPR = '1d100';

export function parseDiceInput(input: string): ParsedInput {
  const match = DICE_COMMAND.exec(input.trim());
  if (!match) return { kind: 'message', content: input };
  return {
    kind: 'dice',
    hidden: match[1] === 'rh',
    expr: (match[2] ?? '').trim() || DEFAULT_DICE_EXPR,
  };
}
