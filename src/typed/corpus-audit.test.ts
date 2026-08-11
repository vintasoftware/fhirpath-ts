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
  it('accounts for accepted, rejected, and budgeted expressions', () => {
    expect(INFERENCE_CORPUS_AUDIT.accepted + INFERENCE_CORPUS_AUDIT.rejected).toBe(
      INFERENCE_CORPUS_AUDIT.distinctExpressions
    )
    expect(INFERENCE_CORPUS_AUDIT.withinBudget + INFERENCE_CORPUS_AUDIT.overBudget.length).toBe(
      INFERENCE_CORPUS_AUDIT.accepted
    )
    expect(INFERENCE_CORPUS_AUDIT.longestWithinBudgetCase.sourceSteps).toBe(INFERENCE_CORPUS_AUDIT.longestWithinBudget)
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
