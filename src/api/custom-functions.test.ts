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

describe('expression-defined custom functions', () => {
  const condition = {
    resourceType: 'Condition',
    id: 'c1',
    code: { coding: [{ code: 'I10', display: 'Hypertension' }] },
  }
  const displayText: CustomFunction = {
    expression: '(text | coding.display.first() | coding.first().code).first()',
  }

  it('evaluates the body with the call input as focus, like a spliced alias', () => {
    expect(evaluate('Condition.code.displayText()', condition, { functions: { displayText } })).toEqual([
      'Hypertension',
    ])
    // The alias is not tied to one resource type: any CodeableConcept focus works.
    const observation = { resourceType: 'Observation', status: 'final', code: { text: 'Weight' } }
    expect(evaluate('Observation.code.displayText()', observation, { functions: { displayText } })).toEqual(['Weight'])
  })

  it('composes with further navigation and receives the whole input collection', () => {
    expect(evaluate('Condition.code.displayText().upper()', condition, { functions: { displayText } })).toEqual([
      'HYPERTENSION',
    ])
    // The body sees the input as one collection, not item by item like select().
    const pick: CustomFunction = { expression: 'skip(1).first()' }
    expect(evaluate('name.given.pick()', patient, { functions: { pick } })).toEqual(['James'])
  })

  it('keeps values typed end-to-end: a Quantity survives where env data would not', () => {
    const observation = {
      resourceType: 'Observation',
      status: 'final',
      code: { text: 'Weight' },
      valueQuantity: { value: 72.5, unit: 'kg', code: 'kg' },
    }
    const qty: CustomFunction = { expression: 'value.ofType(Quantity)' }
    expect(evaluate("Observation.qty() > 70 'kg'", observation, { functions: { qty }, model: r4Model })).toEqual([true])
  })

  it('the body sees the caller environment: %context stays the outer root', () => {
    const rootId: CustomFunction = { expression: '%context.id' }
    expect(evaluate('Condition.code.rootId()', condition, { functions: { rootId } })).toEqual(['c1'])
  })

  it('defineVariable() inside the body stays local to the body', () => {
    const tagged: CustomFunction = { expression: "defineVariable('inner', 'x').select(%inner)" }
    expect(evaluate('tagged()', condition, { functions: { tagged } })).toEqual(['x'])
    expect(() => evaluate('tagged() & %inner', condition, { functions: { tagged } })).toThrow(
      'Undefined environment variable %inner'
    )
  })

  it('takes zero arguments', () => {
    expect(() => evaluate("Condition.code.displayText('x')", condition, { functions: { displayText } })).toThrow(
      "Function 'displayText' expects 0 arguments, got 1"
    )
  })

  it('fails as recursion instead of overflowing, directly or mutually', () => {
    expect(() => evaluate('loop()', condition, { functions: { loop: { expression: 'loop()' } } })).toThrow(
      "Expression-defined function 'loop' calls itself"
    )
    const mutual = { a: { expression: 'b()' }, b: { expression: 'a()' } }
    expect(() => evaluate('a()', condition, { functions: mutual })).toThrow(
      "Expression-defined function 'a' calls itself"
    )
  })

  it('a pre-compiled body is accepted and never re-parsed', () => {
    const precompiled: CustomFunction = { expression: compile('coding.first().code') }
    expect(evaluate('Condition.code.firstCode()', condition, { functions: { firstCode: precompiled } })).toEqual([
      'I10',
    ])
  })

  it('rejects a function declaring both fn and expression, loudly', () => {
    const both = { fn: () => 'x', expression: "'x'" } as CustomFunction
    expect(() => evaluate('both()', condition, { functions: { both } })).toThrow(
      "Custom function 'both' declares both 'fn' and 'expression'"
    )
  })

  it('cannot override a built-in either', () => {
    expect(() => evaluate('name.first()', patient, { functions: { first: { expression: '$this' } } })).toThrow(
      "Cannot override the built-in function 'first'"
    )
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

  it('an expression-defined function resolves with arity 0, and its signature still applies', () => {
    const functions: Record<string, CustomFunction> = {
      displayText: {
        expression: '(text | coding.display.first() | coding.first().code).first()',
        signature: { result: { types: ['System.String'], single: true } },
      },
    }
    const codes = (expression: string): string[] =>
      analyzeExpression(expression, { model: r4Model, inputType: 'Patient', functions }).map(d => d.code)
    expect(codes('maritalStatus.displayText()')).toEqual([])
    expect(codes("maritalStatus.displayText('x')")).toEqual(['wrong-arity'])
    // The declared String result feeds later checks.
    expect(codes('maritalStatus.displayText().length()')).toEqual([])
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
