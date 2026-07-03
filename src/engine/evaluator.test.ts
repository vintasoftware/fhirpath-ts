import { describe, expect, it } from 'vitest'
import { compile } from '../api/compile.ts'
import { evaluate } from '../api/evaluate.ts'
import { fhirpath } from '../api/tagged.ts'
import { FhirPathError, FhirPathRuntimeError, FhirPathTypeError } from '../errors.ts'

const patient = {
  resourceType: 'Patient',
  id: 'example',
  active: true,
  name: [
    { use: 'official', family: 'Chalmers', given: ['Peter', 'James'] },
    { use: 'usual', given: ['Jim'] },
  ],
  birthDate: '1974-12-25',
  deceasedBoolean: false,
  contact: [{ name: { family: 'du Marché' } }],
}

describe('literal evaluation', () => {
  it.each([
    ['true', [true]],
    ['false', [false]],
    ["'abc'", ['abc']],
    ['42', [42]],
    ['3.14', [3.14]],
    ['{}', []],
  ])('%s evaluates to %j', (expression, expected) => {
    expect(evaluate(expression)).toEqual(expected)
  })

  it('evaluates temporal literals to their literal text', () => {
    expect(evaluate('@2014-01-25')).toEqual(['2014-01-25'])
    expect(evaluate('@2014T')).toEqual(['2014'])
    expect(evaluate('@T14:30')).toEqual(['14:30'])
  })

  it('rejects impossible calendar components at evaluation time', () => {
    expect(() => evaluate('@2014-13-01')).toThrow(FhirPathRuntimeError)
  })

  it('evaluates quantity literals', () => {
    expect(evaluate("4.5 'mg'")).toEqual([{ value: 4.5, unit: 'mg' }])
    expect(evaluate('4 days')).toEqual([{ value: 4, unit: 'days' }])
  })
})

describe('path navigation', () => {
  it('navigates simple properties', () => {
    expect(evaluate('id', patient)).toEqual(['example'])
    expect(evaluate('active', patient)).toEqual([true])
  })

  it('applies the root type rule: Patient.x on a Patient', () => {
    expect(evaluate('Patient.id', patient)).toEqual(['example'])
  })

  it('a mismatched root type yields empty', () => {
    expect(evaluate('Encounter.id', patient)).toEqual([])
  })

  it('flattens arrays while navigating', () => {
    expect(evaluate('name.given', patient)).toEqual(['Peter', 'James', 'Jim'])
    expect(evaluate('name.family', patient)).toEqual(['Chalmers'])
  })

  it('missing elements yield empty, not errors', () => {
    expect(evaluate('name.suffix', patient)).toEqual([])
    expect(evaluate('telecom.value', patient)).toEqual([])
  })

  it('navigates through single complex elements', () => {
    expect(evaluate('contact.name.family', patient)).toEqual(['du Marché'])
  })

  it('primitives have no children', () => {
    expect(evaluate('id.value', patient)).toEqual([])
  })

  it('indexes into collections', () => {
    expect(evaluate('name.given[0]', patient)).toEqual(['Peter'])
    expect(evaluate('name.given[2]', patient)).toEqual(['Jim'])
    expect(evaluate('name.given[7]', patient)).toEqual([])
    expect(evaluate('name[1].given', patient)).toEqual(['Jim'])
  })

  it('accepts an array as input', () => {
    expect(evaluate('given', patient.name)).toEqual(['Peter', 'James', 'Jim'])
  })
})

describe('special and environment variables', () => {
  it('$this at the root is the input', () => {
    expect(evaluate('$this', 5)).toEqual([5])
  })

  it('%context is the original input regardless of navigation', () => {
    expect(evaluate('name.given[0]', patient)).toEqual(['Peter'])
    expect(evaluate('%context.id', patient)).toEqual(['example'])
  })

  it('built-in terminology URLs are defined', () => {
    expect(evaluate('%ucum')).toEqual(['http://unitsofmeasure.org'])
    expect(evaluate('%sct')).toEqual(['http://snomed.info/sct'])
    expect(evaluate('%loinc')).toEqual(['http://loinc.org'])
  })

  it('user environment variables resolve with or without the % prefix in keys', () => {
    expect(evaluate('%myVar', undefined, { env: { myVar: 7 } })).toEqual([7])
    expect(evaluate('%myVar', undefined, { env: { '%myVar': 7 } })).toEqual([7])
  })

  it('a defined variable holding nothing is empty', () => {
    expect(evaluate('%nothing', undefined, { env: { nothing: undefined } })).toEqual([])
  })

  it('an undefined environment variable is an error', () => {
    expect(() => evaluate('%unknown')).toThrow(FhirPathTypeError)
    expect(() => evaluate('%unknown')).toThrow('Undefined environment variable %unknown')
  })

  it('$index and $total are errors outside their functions', () => {
    expect(() => evaluate('$index', patient)).toThrow('$index is only defined inside iteration functions')
    expect(() => evaluate('$total', patient)).toThrow('$total is only defined inside aggregate()')
  })
})

describe('unknown functions', () => {
  it('are semantic errors', () => {
    expect(() => evaluate('frobnicate()')).toThrow("Unrecognized function 'frobnicate'")
  })
})

describe('public API', () => {
  it('compile() returns a reusable expression exposing the AST and canonical form', () => {
    const expression = compile('name . given')
    expect(expression.ast.kind).toBe('dot')
    expect(expression.toString()).toBe('name.given')
    expect(expression.evaluate(patient)).toEqual(['Peter', 'James', 'Jim'])
    expect(expression.evaluate(patient)).toEqual(['Peter', 'James', 'Jim'])
  })

  it('evaluateTyped keeps type names', () => {
    const typed = compile('name.given').evaluateTyped(patient)
    expect(typed[0]).toEqual({ type: 'System.String', value: 'Peter' })
  })

  it('evaluate() accepts a CompiledExpression', () => {
    const expression = compile('id')
    expect(evaluate(expression, patient)).toEqual(['example'])
  })

  it('the fhirpath tag compiles static templates and rejects interpolation', () => {
    expect(fhirpath`name.given`.evaluate(patient)).toEqual(['Peter', 'James', 'Jim'])
    const inject = 'name'
    expect(() => {
      // eslint-style suppression is unnecessary: the never[] rest makes this a type error too.
      // @ts-expect-error interpolation is rejected at compile time and at runtime
      return fhirpath`${inject}.given`
    }).toThrow(FhirPathError)
  })

  it('repeated evaluate() calls reuse the parse cache', () => {
    expect(evaluate('birthDate', patient)).toEqual(['1974-12-25'])
    expect(evaluate('birthDate', patient)).toEqual(['1974-12-25'])
  })
})
