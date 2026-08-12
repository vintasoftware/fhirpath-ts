import type { BinaryOperator } from './ast.ts'

/**
 * Binding powers derived from the spec's 13-level operator precedence table.
 * Higher binds tighter; the spec numbers levels in the opposite direction.
 */
export const BindingPower = {
  Implies: 1,
  OrXor: 2,
  And: 3,
  Membership: 4,
  Equality: 5,
  Comparison: 6,
  Union: 7,
  TypeOps: 8,
  Additive: 9,
  Multiplicative: 10,
  Unary: 11,
  Indexer: 12,
  Dot: 13,
  FunctionCall: 14,
} as const

export type InfixParseletRecord =
  | {
      tokenKind: 'operator' | 'keyword'
      fixity: 'infix'
      bindingPower: number
      associativity: 'left'
      rhs: 'expression'
      reducer: 'binary'
    }
  | {
      tokenKind: 'keyword'
      fixity: 'infix'
      bindingPower: number
      associativity: 'left'
      rhs: 'type-name'
      reducer: 'type'
    }
  | {
      tokenKind: 'punct'
      fixity: 'infix'
      bindingPower: number
      associativity: 'left'
      rhs: 'path'
      reducer: 'dot'
    }
  | {
      tokenKind: 'punct'
      fixity: 'postfix'
      bindingPower: number
      associativity: 'left'
      rhs: 'index'
      reducer: 'indexer'
    }
  | {
      tokenKind: 'punct'
      fixity: 'postfix'
      bindingPower: number
      associativity: 'left'
      rhs: 'arguments'
      reducer: 'call'
    }

export type PrefixParseletRecord =
  | {
      tokenKind: 'identifier' | 'variable'
      fixity: 'prefix'
      bindingPower: number
      associativity: 'none'
      rhs: 'none'
      reducer: 'identifier'
    }
  | {
      tokenKind: 'literal'
      fixity: 'prefix'
      bindingPower: number
      associativity: 'none'
      rhs: 'none'
      reducer: 'literal'
    }
  | {
      tokenKind: 'operator'
      fixity: 'prefix'
      bindingPower: number
      associativity: 'right'
      rhs: 'expression'
      reducer: 'unary'
    }
  | {
      tokenKind: 'punct'
      fixity: 'prefix'
      bindingPower: number
      associativity: 'none'
      rhs: 'group'
      reducer: 'group'
    }
  | {
      tokenKind: 'punct'
      fixity: 'prefix'
      bindingPower: number
      associativity: 'none'
      rhs: 'none'
      reducer: 'empty'
    }
  | {
      tokenKind: 'punct'
      fixity: 'prefix'
      bindingPower: number
      associativity: 'none'
      rhs: 'external-name'
      reducer: 'external'
    }

/** Single source of truth for tokens and token kinds accepted before an operand. */
export const PREFIX_PARSELETS = {
  identifier: {
    tokenKind: 'identifier',
    fixity: 'prefix',
    bindingPower: 0,
    associativity: 'none',
    rhs: 'none',
    reducer: 'identifier',
  },
  literal: {
    tokenKind: 'literal',
    fixity: 'prefix',
    bindingPower: 0,
    associativity: 'none',
    rhs: 'none',
    reducer: 'literal',
  },
  variable: {
    tokenKind: 'variable',
    fixity: 'prefix',
    bindingPower: 0,
    associativity: 'none',
    rhs: 'none',
    reducer: 'identifier',
  },
  '+': {
    tokenKind: 'operator',
    fixity: 'prefix',
    bindingPower: BindingPower.Unary,
    associativity: 'right',
    rhs: 'expression',
    reducer: 'unary',
  },
  '-': {
    tokenKind: 'operator',
    fixity: 'prefix',
    bindingPower: BindingPower.Unary,
    associativity: 'right',
    rhs: 'expression',
    reducer: 'unary',
  },
  '(': {
    tokenKind: 'punct',
    fixity: 'prefix',
    bindingPower: 0,
    associativity: 'none',
    rhs: 'group',
    reducer: 'group',
  },
  '{': {
    tokenKind: 'punct',
    fixity: 'prefix',
    bindingPower: 0,
    associativity: 'none',
    rhs: 'none',
    reducer: 'empty',
  },
  '%': {
    tokenKind: 'punct',
    fixity: 'prefix',
    bindingPower: 0,
    associativity: 'none',
    rhs: 'external-name',
    reducer: 'external',
  },
} as const satisfies Record<string, PrefixParseletRecord>

const binary = (
  tokenKind: 'operator' | 'keyword',
  bindingPower: number
): Extract<InfixParseletRecord, { reducer: 'binary' }> => ({
  tokenKind,
  fixity: 'infix',
  bindingPower,
  associativity: 'left',
  rhs: 'expression',
  reducer: 'binary',
})

/** Single source of truth for every token accepted after an operand. */
export const INFIX_PARSELETS = {
  implies: binary('keyword', BindingPower.Implies),
  or: binary('keyword', BindingPower.OrXor),
  xor: binary('keyword', BindingPower.OrXor),
  and: binary('keyword', BindingPower.And),
  in: binary('keyword', BindingPower.Membership),
  contains: binary('keyword', BindingPower.Membership),
  '=': binary('operator', BindingPower.Equality),
  '~': binary('operator', BindingPower.Equality),
  '!=': binary('operator', BindingPower.Equality),
  '!~': binary('operator', BindingPower.Equality),
  '<': binary('operator', BindingPower.Comparison),
  '>': binary('operator', BindingPower.Comparison),
  '<=': binary('operator', BindingPower.Comparison),
  '>=': binary('operator', BindingPower.Comparison),
  '|': binary('operator', BindingPower.Union),
  is: {
    tokenKind: 'keyword',
    fixity: 'infix',
    bindingPower: BindingPower.TypeOps,
    associativity: 'left',
    rhs: 'type-name',
    reducer: 'type',
  },
  as: {
    tokenKind: 'keyword',
    fixity: 'infix',
    bindingPower: BindingPower.TypeOps,
    associativity: 'left',
    rhs: 'type-name',
    reducer: 'type',
  },
  '+': binary('operator', BindingPower.Additive),
  '-': binary('operator', BindingPower.Additive),
  '&': binary('operator', BindingPower.Additive),
  '*': binary('operator', BindingPower.Multiplicative),
  '/': binary('operator', BindingPower.Multiplicative),
  div: binary('keyword', BindingPower.Multiplicative),
  mod: binary('keyword', BindingPower.Multiplicative),
  '[': {
    tokenKind: 'punct',
    fixity: 'postfix',
    bindingPower: BindingPower.Indexer,
    associativity: 'left',
    rhs: 'index',
    reducer: 'indexer',
  },
  '.': {
    tokenKind: 'punct',
    fixity: 'infix',
    bindingPower: BindingPower.Dot,
    associativity: 'left',
    rhs: 'path',
    reducer: 'dot',
  },
  '(': {
    tokenKind: 'punct',
    fixity: 'postfix',
    bindingPower: BindingPower.FunctionCall,
    associativity: 'left',
    rhs: 'arguments',
    reducer: 'call',
  },
} as const satisfies Record<string, InfixParseletRecord>

/** Compatibility view used by callers that only need precedence. */
export const INFIX_BINDING_POWER: Readonly<Record<string, number>> = Object.fromEntries(
  Object.entries(INFIX_PARSELETS).map(([token, record]) => [token, record.bindingPower])
)

/** Compile-time coverage: every binary AST operator has a binary parselet. */
const _binaryOperatorCoverage: Record<BinaryOperator, InfixParseletRecord> = INFIX_PARSELETS
void _binaryOperatorCoverage
