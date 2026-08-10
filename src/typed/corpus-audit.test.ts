import { describe, expect, it } from 'vitest'

import { FUNCTION_SIGNATURES } from '../analyzer/signatures.ts'
import type { BinaryOperator } from '../parser/ast.ts'
import { INFERENCE_CORPUS_AUDIT } from './generated/corpus-audit.ts'

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

describe('reference-derived type-inference inventory', () => {
  it('reproduces the reviewed corpus and scanner-budget baseline', () => {
    expect(INFERENCE_CORPUS_AUDIT).toMatchObject({
      distinctExpressions: 2356,
      accepted: 2348,
      rejected: 8,
      withinBudget: 2347,
      longestWithinBudget: 255,
    })
    expect(INFERENCE_CORPUS_AUDIT.overBudget).toHaveLength(1)
    expect(INFERENCE_CORPUS_AUDIT.overBudget[0]).toMatchObject({ tokens: 208, sourceSteps: 438 })
  })

  it('covers every runtime operator and literal AST kind', () => {
    expect(INFERENCE_CORPUS_AUDIT.operators).toEqual([...BINARY_OPERATORS, 'as', 'is', 'unary+', 'unary-'].sort())
    expect(INFERENCE_CORPUS_AUDIT.literals).toEqual(
      ['boolean', 'date', 'dateTime', 'decimal', 'long', 'null', 'number', 'quantity', 'string', 'time'].sort()
    )
  })

  it('has runnable cases for every signed built-in except the documented skipped gap', () => {
    expect(INFERENCE_CORPUS_AUDIT.signedFunctions).toBe(Object.keys(FUNCTION_SIGNATURES).length)
    expect(INFERENCE_CORPUS_AUDIT.missingSignedFunctions).toEqual(['convertsToLong'])
  })
})
