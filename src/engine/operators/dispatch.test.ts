import { describe, expect, it } from 'vitest'
import type { BinaryOperator } from '../../parser/ast.ts'
import { INFIX_BINDING_POWER } from '../../parser/precedence.ts'
import { binaryOperators, unaryOperators } from './index.ts'

// The tables are Record<Operator, Impl>, so tsc already rejects a missing member.
// This locks the other direction: everything the grammar can parse as an operator
// dispatches to a real implementation.
describe('operator dispatch tables', () => {
  it('covers every infix operator the parser can produce', () => {
    // is/as route through the type-operator path; the rest are postfix constructs.
    const nonBinary = new Set(['is', 'as', '[', '.', '('])
    for (const key of Object.keys(INFIX_BINDING_POWER)) {
      if (!nonBinary.has(key)) {
        expect(binaryOperators[key as BinaryOperator], `binary operator '${key}'`).toBeTypeOf('function')
      }
    }
  })

  it('covers both unary operators', () => {
    expect(Object.keys(unaryOperators).sort()).toEqual(['+', '-'])
  })
})
