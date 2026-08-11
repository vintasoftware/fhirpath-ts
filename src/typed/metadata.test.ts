import { describe, expectTypeOf, it } from 'vitest'

import type { OPERATOR_RESULT_RULES, TYPE_OPERATOR_RESULT_RULES } from '../analyzer/operator-rules.ts'
import type { FunctionSignatureName } from '../analyzer/signatures.ts'
import type { INFIX_PARSELETS, PREFIX_PARSELETS } from '../parser/precedence.ts'
import type {
  CompactFunctionArguments,
  CompactFunctionRules,
  CompactInfixParselets,
  CompactOperatorRules,
  CompactPrefixParselets,
  CompactTypeOperatorRules,
} from './generated/metadata-compact.ts'

describe('generated type-inference metadata', () => {
  it('matches every analyzer function result rule', () => {
    expectTypeOf<keyof CompactFunctionRules>().toEqualTypeOf<FunctionSignatureName>()
    expectTypeOf<keyof CompactFunctionArguments>().toEqualTypeOf<FunctionSignatureName>()
  })

  it('matches parser and operator metadata', () => {
    expectTypeOf<keyof CompactOperatorRules>().toEqualTypeOf<keyof typeof OPERATOR_RESULT_RULES>()
    expectTypeOf<keyof CompactTypeOperatorRules>().toEqualTypeOf<keyof typeof TYPE_OPERATOR_RESULT_RULES>()
    expectTypeOf<keyof CompactPrefixParselets>().toEqualTypeOf<keyof typeof PREFIX_PARSELETS>()
    expectTypeOf<keyof CompactInfixParselets>().toEqualTypeOf<keyof typeof INFIX_PARSELETS>()
  })
})
