import { describe, expect, it } from 'vitest'
import { r4Model } from '../r4/index.ts'
import { type AnalyzerDiagnostic, analyzeExpression } from './analyze.ts'

const options = { model: r4Model, inputType: 'Patient' }

function codes(expression: string, analyzeOptions: Parameters<typeof analyzeExpression>[1] = options): string[] {
  return analyzeExpression(expression, analyzeOptions).map(diagnostic => diagnostic.code)
}

describe('clean expressions produce no diagnostics', () => {
  it.each([
    ["Patient.name.where(use = 'official').given.first()"],
    ['Patient.birthDate < today()'],
    ['name.given.count() > 0'],
    ['Patient.deceased.ofType(boolean)'],
    ['Patient.name.exists() implies Patient.name.first().family.exists()'],
    ["Patient.identifier.where(system = 'urn:x').value"],
    ['Patient.contact.name.family'],
    ["Patient.telecom.where(system = 'phone').value.first().length() > 3"],
    ['Patient.name.given.aggregate($total + $this)'],
    ["Patient.extension('http://x').value.ofType(Quantity).comparable(1 'kg')"],
    ['Patient.children().count()'],
    ['Patient.descendants().ofType(Reference).reference'],
    ['%resource.id'],
    ['Patient.birthDate + 3 months'],
    ["Patient.name.family.first() & ' ' & Patient.name.given.first()"],
  ])('%s', expression => {
    expect(analyzeExpression(expression, options)).toEqual([])
  })
})

describe('spec §11 rules', () => {
  it('flags unknown elements, including choice-key misuse', () => {
    expect(codes('Patient.nope')).toEqual(['unknown-element'])
    expect(codes('Observation.valueQuantity.unit', { model: r4Model, inputType: 'Observation' })).toEqual([
      'unknown-element',
    ])
    expect(codes('Patient.name.gven')).toEqual(['unknown-element'])
  })

  it('flags unknown functions and wrong arity', () => {
    expect(codes('Patient.name.frobnicate()')).toEqual(['unknown-function'])
    expect(codes('Patient.name.take()')).toEqual(['wrong-arity'])
    expect(codes('Patient.name.given.substring(1, 2, 3)')).toContain('wrong-arity')
  })

  it('rule 1: singleton-input functions on collections', () => {
    expect(codes('Patient.name.given.substring(1)')).toEqual(['singleton-required'])
    expect(codes('Patient.name.family.length()')).toEqual(['singleton-required'])
    expect(codes('Patient.name.first().family.length()')).toEqual([])
  })

  it('rule 2/3: argument cardinality and types', () => {
    expect(codes('Patient.name.given.first().startsWith(Patient.name.given)')).toEqual(['argument-singleton'])
    expect(codes('Patient.name.first().family.startsWith(1)')).toEqual(['operand-type'])
    expect(codes('Patient.name.skip(true)')).toEqual(['operand-type'])
  })

  it('rule 4: operators need single-item operands', () => {
    expect(codes('Patient.name.given + Patient.name.family')).toContain('singleton-required')
    expect(codes("Patient.name.given in 'a'")).toEqual(['singleton-required'])
  })

  it('rule 5: operator operand types', () => {
    expect(codes('Patient.birthDate * 2')).toEqual(['operand-type'])
    expect(codes('1 + true')).toEqual(['operand-type'])
    expect(codes("'a' < 1")).toEqual(['operand-type'])
    expect(codes('Patient.name and true')).toEqual(['singleton-required'])
    expect(codes('-Patient.name.first().family')).toEqual(['operand-type'])
  })

  it('rule 6: equality that can never hold', () => {
    expect(codes("1 = 'one'")).toEqual(['equality-incompatible'])
    expect(codes('Patient.birthDate = 5')).toEqual(['equality-incompatible'])
    expect(codes("Patient.active != 'x'")).toEqual(['equality-incompatible'])
    expect(codes('Patient.birthDate = @1974-12-25')).toEqual([])
  })

  it('unknown type names in is/as/ofType', () => {
    expect(codes('Patient.name.ofType(HumanNam)')).toEqual(['unknown-type'])
    expect(codes('Patient.deceased is Banana')).toEqual(['unknown-type'])
    expect(codes('Patient.deceased as System.Banana')).toEqual(['unknown-type'])
    expect(codes('1.is(Integer)')).toEqual([])
  })

  it('is/as need a single item', () => {
    expect(codes('Patient.name is HumanName')).toEqual(['singleton-required'])
    expect(codes('Patient.name.first() is HumanName')).toEqual([])
  })

  it('syntax errors surface as diagnostics with positions', () => {
    const diagnostics = analyzeExpression('Patient..name', options)
    expect(diagnostics).toHaveLength(1)
    expect((diagnostics[0] as AnalyzerDiagnostic).code).toBe('syntax')
    expect((diagnostics[0] as AnalyzerDiagnostic).span.column).toBe(9)
  })

  it('unknown regions mute checks until narrowed, as the spec prescribes', () => {
    expect(codes('Patient.children().nope')).toEqual([])
    expect(codes('%var.anything.goes')).toEqual([])
    expect(codes('Patient.descendants().ofType(HumanName).given.first().length()')).toEqual([])
  })

  it('without a model, only structural checks run', () => {
    expect(codes('whatever.path', {})).toEqual([])
    expect(codes('whatever.frobnicate()', {})).toEqual(['unknown-function'])
    expect(codes("1 = 'one'", {})).toEqual(['equality-incompatible'])
  })
})

describe('signature results feed later checks', () => {
  it.each([
    ['Patient.name.given.first().toChars().count() = 5'],
    ["Patient.name.given.first().split('-').count() > 0"],
    ["Patient.name.given.join(',').length() > 0"],
    ['Patient.name.given.first().trim().upper().lower()'],
    ["Patient.name.given.first().replace('a', 'b').matches('x')"],
    ["Patient.name.given.first().encode('hex').decode('hex')"],
    ['(1.5).round(2).ceiling() + (2.5).floor()'],
    ['(4.0).sqrt().exp().ln() < 10'],
    ['16.log(2) = 4.0'],
    ['(1 | 2 | 3).avg() > 1'],
    ['(1 | 2).sum().toString()'],
    ['Patient.birthDate.toDateTime().yearOf() > 1900'],
    ['now().dateOf() = today()'],
    ['timeOfDay().hourOf() >= 0'],
    ['@2014.lowBoundary(6).toString()'],
    ['1.587.precision() = 3'],
    ['Patient.name.sort(family).first().family'],
    ['Patient.name.given.distinct().isDistinct()'],
    ['Patient.name.tail().skip(1).take(1).count() = 0'],
    ["defineVariable('x', name.first()).select(%x).exists()"],
    ["Patient.name.trace('names', given).count() = 2"],
    ["Patient.telecom.value.first().toQuantity('mg').exists() or true"],
    ['Patient.name.first().hasValue().not()'],
    ['Patient.gender.getValue()'],
  ])('%s', expression => {
    const diagnostics = analyzeExpression(expression, options)
    expect(diagnostics.filter(d => d.code !== 'operand-type')).toEqual([])
  })

  it('remaining structural branches', () => {
    expect(codes('Patient.name[true]')).toEqual(['operand-type'])
    expect(codes('{}.count() = 0')).toEqual([])
    expect(codes('@2014 is Banana')).toEqual(['unknown-type'])
    expect(codes('Patient.deceased as boolean')).toEqual([])
    expect(codes('Patient.name.first() as FHIR.HumanName')).toEqual([])
    expect(codes('Patient.name.first() as Nope.HumanName')).toEqual(['unknown-type'])
    expect(codes('1.combine(2).union(3)')).toEqual([])
    expect(codes('Patient.name.given.first().substring({}.count())')).toEqual([])
    expect(codes("'a'.indexOf('a') >= 0 xor false")).toEqual([])
    expect(codes('(3 | 1).sort(-$this).first() = 3')).toEqual([])
    expect(codes('Patient.name.allTrue()')).toEqual(['operand-type'])
    expect(codes('$total.empty() or $index > 0', options)).toEqual([])
  })
})

describe('analyzer edge branches', () => {
  it('mixed-kind choice unions mute kind checks', () => {
    expect(codes('Patient.deceased + 1')).toEqual([])
    expect(codes('Patient.deceased = Patient.deceased')).toEqual([])
  })

  it('malformed type arguments are unknown types', () => {
    expect(codes('1.ofType(exists().x)')).toEqual(['unknown-type'])
  })

  it('conversion signature results flow onward', () => {
    expect(codes("'5'.toLong() > %x")).toEqual([])
    expect(codes("'2014'.toDate() < today()")).toEqual([])
    expect(codes("'2014'.toDateTime().monthOf()")).toEqual([])
    expect(codes("'10:00'.toTime().hourOf()")).toEqual([])
    expect(codes('now().timeOf() > @T00:00')).toEqual([])
    expect(codes("1.toQuantity('mg').comparable(1 'g')")).toEqual([])
  })
})
