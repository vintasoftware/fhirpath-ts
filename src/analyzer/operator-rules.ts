import type { BinaryOperator } from '../parser/ast.ts'
import { valueKindOfTypeName } from '../values/type-compat.ts'
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
      const leftKind = commonKind(left)
      const rightKind = commonKind(right)
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

function commonKind(state: StaticStateLike): ReturnType<typeof valueKindOfTypeName> | undefined {
  if (state.types === undefined || state.types.length === 0) {
    return undefined
  }
  let found: ReturnType<typeof valueKindOfTypeName> | undefined
  for (const type of state.types) {
    const next = valueKindOfTypeName(type)
    if (found !== undefined && found !== next) {
      return undefined
    }
    found = next
  }
  return found
}
