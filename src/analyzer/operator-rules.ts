import type { BinaryOperator } from '../parser/ast.ts'
import { commonValueKind } from '../values/type-compat.ts'
import { type StaticStateLike, unionStates, withSingle } from './signatures.ts'

export type OperatorResultRule =
  | { kind: 'fixed'; types: readonly string[]; single: boolean }
  | { kind: 'arithmetic' }
  | { kind: 'union' }
  | { kind: 'narrow' }

const BOOLEAN = { kind: 'fixed', types: ['System.Boolean'], single: true } as const

/** Result semantics for every runtime binary operator. */
export const OPERATOR_RESULT_RULES = {
  '*': { kind: 'arithmetic' },
  '/': { kind: 'arithmetic' },
  div: { kind: 'arithmetic' },
  mod: { kind: 'arithmetic' },
  '+': { kind: 'arithmetic' },
  '-': { kind: 'arithmetic' },
  '&': { kind: 'fixed', types: ['System.String'], single: true },
  '|': { kind: 'union' },
  '<': BOOLEAN,
  '>': BOOLEAN,
  '<=': BOOLEAN,
  '>=': BOOLEAN,
  '=': BOOLEAN,
  '~': BOOLEAN,
  '!=': BOOLEAN,
  '!~': BOOLEAN,
  in: BOOLEAN,
  contains: BOOLEAN,
  and: BOOLEAN,
  or: BOOLEAN,
  xor: BOOLEAN,
  implies: BOOLEAN,
} as const satisfies Record<BinaryOperator, OperatorResultRule>

export const TYPE_OPERATOR_RESULT_RULES = {
  is: BOOLEAN,
  as: { kind: 'narrow' },
} as const satisfies Record<'is' | 'as', OperatorResultRule>

/** Interpret a binary rule after the analyzer has reported operand diagnostics. */
export function applyOperatorResultRule(
  operator: BinaryOperator,
  left: StaticStateLike,
  right: StaticStateLike
): StaticStateLike {
  const rule = OPERATOR_RESULT_RULES[operator]
  switch (rule.kind) {
    case 'fixed':
      return { types: [...rule.types], single: rule.single }
    case 'arithmetic': {
      const leftKind = commonValueKind(left.types)
      const rightKind = commonValueKind(right.types)
      const quantity = (operator === '*' || operator === '/') && (leftKind === 'Quantity' || rightKind === 'Quantity')
      return {
        types: quantity ? ['System.Quantity'] : operator === '/' ? ['System.Decimal'] : (left.types ?? right.types),
        single: true,
      }
    }
    case 'union':
      if (left.types?.length === 0) {
        return right
      }
      if (right.types?.length === 0) {
        return left
      }
      return withSingle(unionStates([left, right]), false)
  }
}

/** Interpret a type-operator rule after the analyzer has validated its operand and target. */
export function applyTypeOperatorResultRule(
  operator: keyof typeof TYPE_OPERATOR_RESULT_RULES,
  narrowedTypes: readonly string[] | undefined
): StaticStateLike {
  const rule = TYPE_OPERATOR_RESULT_RULES[operator]
  switch (rule.kind) {
    case 'fixed':
      return { types: [...rule.types], single: rule.single }
    case 'narrow':
      return narrowedTypes === undefined
        ? { types: undefined, single: undefined }
        : { types: [...narrowedTypes], single: true }
  }
}
