import { describe, expect, it } from 'vitest'
import { evaluate } from '../../api/evaluate'
import { wrapBoolean } from '../../values/collection'
import { binaryOperators, registerTypeOperator, unaryOperators } from './index'

// This file registers throwaway implementations to exercise the dispatch layer.
// Real operator implementations replace these in their own modules; per-file
// test isolation (forks pool) keeps this from leaking into other test files.
describe('operator dispatch', () => {
  it('routes binary operators through the table', () => {
    binaryOperators.set('+', (_context, left, right) => [...left, ...right])
    expect(evaluate('1 + 2')).toEqual([1, 2])
  })

  it('routes unary operators through the table', () => {
    unaryOperators.set('-', (_context, operand) => operand)
    expect(evaluate('-5')).toEqual([5])
  })

  it('routes type operators through the registered implementation', () => {
    registerTypeOperator((_context, operator, _operand, type) =>
      wrapBoolean(operator === 'is' && type.parts.join('.') === 'System.Integer')
    )
    expect(evaluate('1 is System.Integer')).toEqual([true])
    expect(evaluate('1 is String')).toEqual([false])
  })
})
