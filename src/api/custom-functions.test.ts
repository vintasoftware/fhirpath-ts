import { describe, expect, it } from 'vitest'

import { analyzeExpression } from '../analyzer/analyze.ts'
import { compile, type CustomFunction, evaluate } from '../index.ts'
import { r4Model } from '../r4/index.ts'

const patient = {
  resourceType: 'Patient',
  name: [{ family: 'Chalmers', given: ['Peter', 'James'] }],
  birthDate: '1974-12-25',
}

/**
 * The HAPI-style triple on one record: resolve (name + arity), check
 * (signature), execute (fn) — passed unchanged to evaluate() and the analyzer.
 */
const functions: Record<string, CustomFunction> = {
  initials: {
    minArity: 0,
    maxArity: 0,
    signature: {
      input: { kind: 'String' },
      result: { types: ['System.String'], single: false },
    },
    fn: input => input.map(value => String(value).charAt(0)),
  },
  pickFirst: {
    minArity: 1,
    fn: (_input, arg) => arg?.[0],
  },
}

describe('custom functions at runtime', () => {
  it('receives unwrapped input and eager unwrapped arguments, returns plain values', () => {
    expect(evaluate('name.given.initials()', patient, { functions })).toEqual(['P', 'J'])
    expect(evaluate("pickFirst(name.family, 'fallback')", patient, { functions })).toEqual(['Chalmers'])
  })

  it('undefined and array results become empty and multi-item collections', () => {
    expect(evaluate('pickFirst({})', patient, { functions })).toEqual([])
    const explode: Record<string, CustomFunction> = { explode: { fn: input => [...input, ...input] } }
    expect(evaluate('name.given.explode().count()', patient, { functions: explode })).toEqual([4])
  })

  it('checks arity before invoking', () => {
    expect(() => evaluate('pickFirst()', patient, { functions })).toThrow(
      "Function 'pickFirst' expects at least 1 argument, got 0"
    )
    expect(() => evaluate("name.given.initials('x')", patient, { functions })).toThrow(
      "Function 'initials' expects 0 arguments, got 1"
    )
  })

  it('rejects overriding a built-in, loudly', () => {
    const override: Record<string, CustomFunction> = { where: { fn: input => input } }
    expect(() => evaluate('name.where(true)', patient, { functions: override })).toThrow(
      "Cannot override the built-in function 'where'"
    )
  })

  it('still rejects genuinely unknown functions', () => {
    expect(() => evaluate('name.frobnicate()', patient, { functions })).toThrow("Unrecognized function 'frobnicate'")
  })

  it('arguments evaluate against $this with their own variable scope', () => {
    // The argument navigates the Patient, not the (String) input collection.
    expect(evaluate('name.given.pickFirst(name.family)', patient, { functions })).toEqual(['Chalmers'])
  })

  it('works through compiled expressions too', () => {
    const compiled = compile('name.given.initials()')
    expect(compiled.evaluate(patient as never, { functions })).toEqual(['P', 'J'])
  })
})

describe('custom functions in the analyzer', () => {
  const options = { model: r4Model, inputType: 'Patient', functions }
  const codes = (expression: string): string[] => analyzeExpression(expression, options).map(d => d.code)

  it('declared names resolve instead of failing unknown-function', () => {
    expect(codes('name.given.initials()')).toEqual([])
    expect(codes("pickFirst(name, 'x')")).toEqual([])
  })

  it('declared arities are enforced', () => {
    expect(codes('pickFirst()')).toEqual(['wrong-arity'])
    expect(codes("name.given.initials('x')")).toEqual(['wrong-arity'])
  })

  it('a signature type-checks input and types the result', () => {
    // initials() declares a String input; birthDate is a date.
    expect(codes('birthDate.initials()')).toEqual(['operand-type'])
    // The declared String result feeds later checks.
    expect(codes('name.given.initials().first().length()')).toEqual([])
    expect(codes('name.given.initials() + 1')).toContain('singleton-required')
  })

  it('a function without a signature stays a known-but-opaque unknown region', () => {
    expect(codes('pickFirst(name).anything.goes')).toEqual([])
  })

  it('built-ins cannot be shadowed by a declaration', () => {
    const shadow = { model: r4Model, inputType: 'Patient' as const, functions: { where: { minArity: 0 } } }
    // where() keeps its built-in signature: the expression argument is still checked.
    expect(analyzeExpression('name.where(nope)', shadow).map(d => d.code)).toEqual(['unknown-element'])
  })

  it('typo suggestions include declared functions', () => {
    const messages = analyzeExpression('name.given.initialz()', options).map(d => d.message)
    expect(messages).toEqual(["Unrecognized function 'initialz' — did you mean 'initials'?"])
  })
})

describe('declared variables in the analyzer', () => {
  it('declared names are not unknown-variable errors, typed or not', () => {
    const options = {
      model: r4Model,
      inputType: 'Patient' as const,
      variables: { untyped: {}, '%weight': { types: ['System.Quantity'], single: true } },
    }
    const codes = (expression: string): string[] => analyzeExpression(expression, options).map(d => d.code)
    expect(codes('%untyped.anything.goes')).toEqual([])
    expect(codes("%weight > 3 'kg'")).toEqual([])
    expect(codes("%weight + 'x'")).toEqual(['operand-type'])
    expect(codes('%undeclared')).toEqual(['unknown-variable'])
    // Declared variables are environment variables: defineVariable cannot shadow them.
    expect(codes("defineVariable('weight', 1)")).toEqual(['variable-override'])
  })

  it('declared FHIR types canonicalize through the model', () => {
    const options = { model: r4Model, variables: { pat: { types: ['Patient'], single: true } } }
    expect(analyzeExpression('%pat.name.given', options)).toEqual([])
    expect(analyzeExpression('%pat.nope', options).map(d => d.code)).toEqual(['unknown-element'])
  })
})

// Type-level guard: host functions receive eagerly evaluated values, so their
// signatures cannot declare analyzer lambda semantics the runtime won't honor.
const invalidSignature: CustomFunction = {
  fn: () => undefined,
  // @ts-expect-error -- 'expression' is a lambda spec; only 'any' and ValueKinds are eager
  signature: { args: ['expression'] },
}
void invalidSignature
