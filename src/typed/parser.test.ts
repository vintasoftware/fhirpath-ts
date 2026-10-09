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

  it('accepts token 128 and bails before token 129', () => {
    expectTypeOf<TokenizationStatus<Words<128>>>().toEqualTypeOf<128>()
    expectTypeOf<TokenizationStatus<Words<129>>>().toEqualTypeOf<'opaque'>()
    expectTypeOf<FhirpathResult<Words<129>>>().toEqualTypeOf<unknown[]>()
  })

  it('accepts source step 512 and bails before source step 513', () => {
    expectTypeOf<TokenizationStatus<Quoted<510>>>().toEqualTypeOf<1>()
    expectTypeOf<TokenizationStatus<Quoted<511>>>().toEqualTypeOf<'opaque'>()
    expectTypeOf<FhirpathResult<Quoted<511>>>().toEqualTypeOf<unknown[]>()
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

  it('reads asc and desc only at the end of a sort() key', () => {
    expectTypeOf<FhirpathResult<'Patient.name.sort(family desc, given.first() asc).first()'>>().toEqualTypeOf<
      HumanName[]
    >()
    expectTypeOf<FhirpathResult<'Patient.name.sort(desc desc)'>>().toEqualTypeOf<HumanName[]>()
    expectTypeOf<FhirpathResult<'Patient.name.where(family desc)'>>().toEqualTypeOf<unknown[]>()
    expectTypeOf<FhirpathResult<'Patient.name.sort((family desc))'>>().toEqualTypeOf<unknown[]>()
    expectTypeOf<FhirpathResult<'Patient.name.sort(family desc + 1)'>>().toEqualTypeOf<unknown[]>()
  })

  it('accepts only an integer-typed index expression', () => {
    expectTypeOf<FhirpathResult<'Patient.name[0]'>>().toEqualTypeOf<HumanName[]>()
    expectTypeOf<FhirpathResult<"Patient.name['integer']">>().toEqualTypeOf<unknown[]>()
  })

  it('degrades an over-budget shortcut identifier without exhausting the compiler', () => {
    expectTypeOf<
      FhirpathResult<'Patient.name.select(aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)'>
    >().toEqualTypeOf<unknown[]>()
  })
})
