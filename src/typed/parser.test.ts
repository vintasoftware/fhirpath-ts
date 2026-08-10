import { describe, expectTypeOf, it } from 'vitest'

import type { HumanName } from '../r4/generated/type-maps.ts'
import type { FhirpathResult } from './infer.ts'
import type { TokenizationStatus } from './parser.ts'

type Words<Count extends number, Seen extends unknown[] = [], Result extends string = ''> = Seen['length'] extends Count
  ? Result
  : Words<Count, [...Seen, 0], Result extends '' ? 'x' : `${Result} x`>

type Repeat<
  Count extends number,
  Seen extends unknown[] = [],
  Result extends string = '',
> = Seen['length'] extends Count ? Result : Repeat<Count, [...Seen, 0], `${Result}x`>

type Quoted<ContentLength extends number> = `'${Repeat<ContentLength>}'`

describe('bounded type-level tokenizer and parser', () => {
  it('counts semantic tokens after trivia and recognizes quoted forms', () => {
    expectTypeOf<TokenizationStatus<'Patient /* . | ( ignored ) */ . name'>>().toEqualTypeOf<3>()
    expectTypeOf<TokenizationStatus<"Patient.name.where(family = 'it\\'s')">>().toEqualTypeOf<10>()
    expectTypeOf<TokenizationStatus<'Patient.name.where(`div`.exists())'>>().toEqualTypeOf<12>()
    expectTypeOf<TokenizationStatus<"'unterminated">>().toEqualTypeOf<'opaque'>()
  })

  it('accepts token 64 and bails before token 65', () => {
    expectTypeOf<TokenizationStatus<Words<64>>>().toEqualTypeOf<64>()
    expectTypeOf<TokenizationStatus<Words<65>>>().toEqualTypeOf<'opaque'>()
    expectTypeOf<FhirpathResult<Words<65>>>().toEqualTypeOf<unknown[]>()
  })

  it('accepts source step 256 and bails before source step 257', () => {
    expectTypeOf<TokenizationStatus<Quoted<254>>>().toEqualTypeOf<1>()
    expectTypeOf<TokenizationStatus<Quoted<255>>>().toEqualTypeOf<'opaque'>()
    expectTypeOf<FhirpathResult<Quoted<255>>>().toEqualTypeOf<unknown[]>()
  })

  it('keeps the original navigation, frame, and call subset precise', () => {
    expectTypeOf<FhirpathResult<'Patient /* path trivia */ .name[0]'>>().toEqualTypeOf<HumanName[]>()
    expectTypeOf<FhirpathResult<'(Patient.name).given.first()'>>().toEqualTypeOf<string[]>()
    expectTypeOf<FhirpathResult<'Patient.name.select((given | family)).first()'>>().toEqualTypeOf<string[]>()
    expectTypeOf<FhirpathResult<'%rowIndex.toString().upper()'>>().toEqualTypeOf<string[]>()
  })

  it('returns opaque for malformed delimiters and trailing tokens', () => {
    expectTypeOf<FhirpathResult<'Patient.name['>>().toEqualTypeOf<unknown[]>()
    expectTypeOf<FhirpathResult<'Patient.name) trailing'>>().toEqualTypeOf<unknown[]>()
    expectTypeOf<FhirpathResult<'(Patient.name)(given)'>>().toEqualTypeOf<unknown[]>()
  })
})
