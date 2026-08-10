import { describe, expect, it } from 'vitest'

import { OPERATOR_RESULT_RULES, TYPE_OPERATOR_RESULT_RULES } from '../analyzer/operator-rules.ts'
import { FUNCTION_SIGNATURES } from '../analyzer/signatures.ts'
import { INFIX_PARSELETS, PREFIX_PARSELETS } from '../parser/precedence.ts'
import {
  TYPE_FUNCTION_RULES,
  TYPE_INFIX_PARSELETS,
  TYPE_OPERATOR_RULES,
  TYPE_PREFIX_PARSELETS,
  TYPE_TYPE_OPERATOR_RULES,
} from './generated/metadata.ts'

describe('generated type-inference metadata', () => {
  it('matches every analyzer function result rule', () => {
    const runtimeRules = Object.fromEntries(
      Object.entries(FUNCTION_SIGNATURES).map(([name, signature]) => [name, signature.result])
    )
    expect(TYPE_FUNCTION_RULES).toEqual(runtimeRules)
  })

  it('matches parser and operator metadata', () => {
    expect(TYPE_OPERATOR_RULES).toEqual(OPERATOR_RESULT_RULES)
    expect(TYPE_TYPE_OPERATOR_RULES).toEqual(TYPE_OPERATOR_RESULT_RULES)
    expect(TYPE_PREFIX_PARSELETS).toEqual(PREFIX_PARSELETS)
    expect(TYPE_INFIX_PARSELETS).toEqual(INFIX_PARSELETS)
  })
})
