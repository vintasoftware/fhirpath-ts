import { describe, expectTypeOf, it } from 'vitest'

import type { HumanName, Quantity, SystemQuantity } from '../r4/generated/type-maps.ts'
import type { FhirpathResult } from './infer.ts'

describe('type-level literals', () => {
  it('infers every runtime literal shape', () => {
    expectTypeOf<FhirpathResult<'{}'>>().toEqualTypeOf<never[]>()
    expectTypeOf<FhirpathResult<'true'>>().toEqualTypeOf<boolean[]>()
    expectTypeOf<FhirpathResult<'7'>>().toEqualTypeOf<number[]>()
    expectTypeOf<FhirpathResult<'7L'>>().toEqualTypeOf<bigint[]>()
    expectTypeOf<FhirpathResult<'7.3'>>().toEqualTypeOf<number[]>()
    expectTypeOf<FhirpathResult<"'FHIRPath'">>().toEqualTypeOf<string[]>()
    expectTypeOf<FhirpathResult<'@2019-01-01'>>().toEqualTypeOf<string[]>()
    expectTypeOf<FhirpathResult<'@2019-01-01T12:30:00Z'>>().toEqualTypeOf<string[]>()
    expectTypeOf<FhirpathResult<'@T12:30:00'>>().toEqualTypeOf<string[]>()
    expectTypeOf<FhirpathResult<"2 'mg'">>().toEqualTypeOf<SystemQuantity[]>()
    expectTypeOf<FhirpathResult<'2 days'>>().toEqualTypeOf<SystemQuantity[]>()
  })

  it('handles escaped strings and delimited identifiers without losing token boundaries', () => {
    expectTypeOf<FhirpathResult<"'it\\'s'">>().toEqualTypeOf<string[]>()
    expectTypeOf<FhirpathResult<'Patient.`name`'>>().toEqualTypeOf<HumanName[]>()
  })

  it('degrades invalid or incomplete literal syntax', () => {
    expectTypeOf<FhirpathResult<'2 items'>>().toEqualTypeOf<unknown[]>()
    expectTypeOf<FhirpathResult<'@T14:30Z'>>().toEqualTypeOf<unknown[]>()
    expectTypeOf<FhirpathResult<"'unterminated">>().toEqualTypeOf<unknown[]>()
  })
})

describe('type-level operators', () => {
  it('infers unary and arithmetic results', () => {
    expectTypeOf<FhirpathResult<'+7'>>().toEqualTypeOf<number[]>()
    expectTypeOf<FhirpathResult<'-7L'>>().toEqualTypeOf<bigint[]>()
    expectTypeOf<FhirpathResult<'2 * 4'>>().toEqualTypeOf<number[]>()
    expectTypeOf<FhirpathResult<'5 / 2'>>().toEqualTypeOf<number[]>()
    expectTypeOf<FhirpathResult<'5 div 2'>>().toEqualTypeOf<number[]>()
    expectTypeOf<FhirpathResult<'5 mod 2'>>().toEqualTypeOf<number[]>()
    expectTypeOf<FhirpathResult<'2 + 3'>>().toEqualTypeOf<number[]>()
    expectTypeOf<FhirpathResult<'5 - 3'>>().toEqualTypeOf<number[]>()
    expectTypeOf<FhirpathResult<"2 'mg' * 3">>().toEqualTypeOf<SystemQuantity[]>()
  })

  it('infers string, collection, comparison, equality, membership, and Boolean results', () => {
    expectTypeOf<FhirpathResult<"'a' & 'b'">>().toEqualTypeOf<string[]>()
    expectTypeOf<FhirpathResult<'1 | true'>>().toEqualTypeOf<(number | boolean)[]>()
    expectTypeOf<FhirpathResult<'1 < 2'>>().toEqualTypeOf<boolean[]>()
    expectTypeOf<FhirpathResult<'1 > 2'>>().toEqualTypeOf<boolean[]>()
    expectTypeOf<FhirpathResult<'1 <= 2'>>().toEqualTypeOf<boolean[]>()
    expectTypeOf<FhirpathResult<'1 >= 2'>>().toEqualTypeOf<boolean[]>()
    expectTypeOf<FhirpathResult<'1 = 2'>>().toEqualTypeOf<boolean[]>()
    expectTypeOf<FhirpathResult<'1 != 2'>>().toEqualTypeOf<boolean[]>()
    expectTypeOf<FhirpathResult<'1 ~ 2'>>().toEqualTypeOf<boolean[]>()
    expectTypeOf<FhirpathResult<'1 !~ 2'>>().toEqualTypeOf<boolean[]>()
    expectTypeOf<FhirpathResult<'1 in (1 | 2)'>>().toEqualTypeOf<boolean[]>()
    expectTypeOf<FhirpathResult<'(1 | 2) contains 1'>>().toEqualTypeOf<boolean[]>()
    expectTypeOf<FhirpathResult<'true and false'>>().toEqualTypeOf<boolean[]>()
    expectTypeOf<FhirpathResult<'true xor false'>>().toEqualTypeOf<boolean[]>()
    expectTypeOf<FhirpathResult<'true or false'>>().toEqualTypeOf<boolean[]>()
    expectTypeOf<FhirpathResult<'true implies false'>>().toEqualTypeOf<boolean[]>()
  })

  it('infers type tests and compatible narrowing', () => {
    expectTypeOf<FhirpathResult<'5L is Long'>>().toEqualTypeOf<boolean[]>()
    expectTypeOf<FhirpathResult<'Observation.value as Quantity'>>().toEqualTypeOf<Quantity[]>()
    expectTypeOf<FhirpathResult<'Patient as Observation'>>().toEqualTypeOf<unknown[]>()
  })

  it('applies every adjacent precedence boundary', () => {
    expectTypeOf<FhirpathResult<'-Patient.name.count()'>>().toEqualTypeOf<number[]>()
    expectTypeOf<FhirpathResult<'-Patient.name[0].given.count()'>>().toEqualTypeOf<number[]>()
    expectTypeOf<FhirpathResult<'-1 * 2'>>().toEqualTypeOf<number[]>()
    expectTypeOf<FhirpathResult<'1 + 2 * 3'>>().toEqualTypeOf<number[]>()
    expectTypeOf<FhirpathResult<'1 + 2 is Integer'>>().toEqualTypeOf<boolean[]>()
    expectTypeOf<FhirpathResult<'1 | 2 is Integer'>>().toEqualTypeOf<(number | boolean)[]>()
    expectTypeOf<FhirpathResult<'1 < 2 | 3'>>().toEqualTypeOf<boolean[]>()
    expectTypeOf<FhirpathResult<'true = 1 < 2'>>().toEqualTypeOf<boolean[]>()
    expectTypeOf<FhirpathResult<'1 in {} = false'>>().toEqualTypeOf<boolean[]>()
    expectTypeOf<FhirpathResult<'1 in {} and true'>>().toEqualTypeOf<boolean[]>()
    expectTypeOf<FhirpathResult<'true or false and false'>>().toEqualTypeOf<boolean[]>()
    expectTypeOf<FhirpathResult<'true implies false or true'>>().toEqualTypeOf<boolean[]>()
  })
})
