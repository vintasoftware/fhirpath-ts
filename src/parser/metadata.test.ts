import { describe, expect, it } from 'vitest'

import { OPERATOR_RESULT_RULES, TYPE_OPERATOR_RESULT_RULES } from '../analyzer/operator-rules.ts'
import type { BinaryOperator } from './ast.ts'
import { parse } from './parser.ts'
import { INFIX_PARSELETS } from './precedence.ts'

const BINARY_OPERATORS = [
  '*',
  '/',
  'div',
  'mod',
  '+',
  '-',
  '&',
  '|',
  '<',
  '>',
  '<=',
  '>=',
  '=',
  '~',
  '!=',
  '!~',
  'in',
  'contains',
  'and',
  'or',
  'xor',
  'implies',
] as const satisfies readonly BinaryOperator[]

describe('parser metadata parity', () => {
  it('gives every binary operator one parselet and one result rule', () => {
    expect(Object.keys(OPERATOR_RESULT_RULES).sort()).toEqual([...BINARY_OPERATORS].sort())
    for (const operator of BINARY_OPERATORS) {
      expect(INFIX_PARSELETS[operator].reducer).toBe('binary')
      expect(parse(`1 ${operator} 1`)).toMatchObject({ kind: 'binary', operator })
    }
  })

  it('uses type-name RHS metadata for both type operators', () => {
    expect(Object.keys(TYPE_OPERATOR_RESULT_RULES).sort()).toEqual(['as', 'is'])
    for (const operator of ['as', 'is'] as const) {
      expect(INFIX_PARSELETS[operator]).toMatchObject({ reducer: 'type', rhs: 'type-name' })
      expect(parse(`1 ${operator} System.Integer`)).toMatchObject({ kind: 'typeOp', operator })
    }
  })

  it('describes calls, indexers, and navigation as distinct RHS modes', () => {
    expect(INFIX_PARSELETS['(']).toMatchObject({ fixity: 'postfix', rhs: 'arguments', reducer: 'call' })
    expect(INFIX_PARSELETS['[']).toMatchObject({ fixity: 'postfix', rhs: 'index', reducer: 'indexer' })
    expect(INFIX_PARSELETS['.']).toMatchObject({ fixity: 'infix', rhs: 'path', reducer: 'dot' })
  })
})
