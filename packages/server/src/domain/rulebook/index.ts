import { DEFAULT_NAT20_RULE, type Nat20Rule, type RuleBookId } from '@behindveil/shared';
import { Coc7RuleBook } from './coc7.js';
import { DND5E_DEFAULT_DC, Dnd5eRuleBook } from './dnd5e.js';
import type { RuleBook } from './types.js';

/**
 * 规则书工厂（T-M7-04，设计文档 v2 §5.1）。
 *
 * v1 在网关/执行器/复现器三处各 hardcode 了 Coc7RuleBook，v2 起统一由本工厂按会话装配：
 * 规则书选择源是会话所装模组（KP 卡 rulebook 优先，回退 manifest），缺省 coc7（向后兼容）。
 * 规则书无状态，可随用随建；此处不做缓存（缓存属装配层的事）。
 */
export interface RuleBookOptions {
  /** nat20/nat1 适用面（仅 5e 消费）；缺省 attack_only */
  nat20Rule?: Nat20Rule;
}

export function createRuleBook(id: RuleBookId, options: RuleBookOptions = {}): RuleBook {
  switch (id) {
    case 'coc7':
      return new Coc7RuleBook();
    case 'dnd5e':
      return new Dnd5eRuleBook({ nat20Rule: options.nat20Rule ?? DEFAULT_NAT20_RULE });
  }
}

/** 5e KP 未指定 DC 时按难度档推定的缺省值（normal 10 / hard 15 / extreme 20），执行器消费 */
export { DND5E_DEFAULT_DC };

/** 会话/模组里读到的规则书标识归一：未知值与空值一律按 coc7（v1 存量数据无此字段） */
export function ruleBookIdOf(value: string | null | undefined): RuleBookId {
  return value === 'dnd5e' ? 'dnd5e' : 'coc7';
}
