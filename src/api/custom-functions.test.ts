import { describe, expect, it } from 'vitest'

import { analyzeExpression, analyzeExpressionDetailed } from '../analyzer/analyze.ts'
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

  it('a definition may carry env of its own, over the caller env and only inside the body', () => {
    const labelled: CustomFunction = {
      // Data the definition owns, the way a DTO's `static env` reaches its
      // columns: readable here, and nowhere the definition was not called.
      expression: "%prefix.combine(%outer).combine(coding.first().code).join('/')",
      env: { prefix: 'own', '%outer': 'shadowed' },
    }
    const options = { functions: { labelled }, env: { outer: 'callers' } }
    expect(evaluate('Condition.code.labelled()', condition, options)).toEqual(['own/shadowed/I10'])
    // Before and after the call the caller's own value is what %outer means,
    // and the name the definition added is not defined at all.
    expect(evaluate('%outer.combine(Condition.code.labelled()).combine(%outer)', condition, options)).toEqual([
      'callers',
      'own/shadowed/I10',
      'callers',
    ])
    expect(() => evaluate('%prefix', condition, options)).toThrow('Undefined environment variable %prefix')
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

  it('infers an undeclared expression body under the call focus and its local type overlay', () => {
    const functions = {
      displayText: { expression: '(text | coding.display.first() | coding.first().code).first()' },
      labelled: {
        expression: '%prefix & text',
        envTypes: { prefix: { type: 'string' } },
      },
      holds: { expression: 'nothing.here', criteria: true },
    } as const satisfies Record<string, CustomFunction>
    const analyze = (expression: string) =>
      analyzeExpressionDetailed(expression, { model: r4Model, inputType: 'Condition', functions }).result

    expect(analyze('code.displayText()')).toEqual({ types: ['FHIR.string', 'FHIR.code'], single: true })
    expect(analyze('code.labelled()')).toEqual({ types: ['System.String'], single: true })
    expect(analyze('code.holds()')).toEqual({ types: ['System.Boolean'], single: true })
  })

  it('collects element dependencies from a criteria body', () => {
    const functions = {
      isNamed: { expression: 'name.given.exists()', criteria: true },
    } as const satisfies Record<string, CustomFunction>
    const details = analyzeExpressionDetailed('Patient.isNamed()', { model: r4Model, functions })

    expect(details.result).toEqual({ types: ['System.Boolean'], single: true })
    expect(details.elementDependencies).toEqual(['Patient.name', 'HumanName.given'])
  })

  it('reuses a compiled body AST and preserves caller variables over a local environment', () => {
    const compiled = compile('%prefix')
    Object.defineProperty(compiled, 'source', { value: 'not valid (' })
    const functions = {
      readPrefix: {
        expression: compiled,
        envTypes: { prefix: { type: 'integer' } },
      },
    } as const satisfies Record<string, CustomFunction>
    const result = analyzeExpressionDetailed("defineVariable('prefix', 'caller').readPrefix()", {
      model: r4Model,
      inputType: 'Patient',
      functions,
    }).result

    expect(result).toEqual({ types: ['System.String'], single: true })
  })

  it('keeps recursive and malformed expression bodies opaque', () => {
    const analyze = (expression: string, body: string) =>
      analyzeExpressionDetailed(expression, {
        model: r4Model,
        functions: { recurse: { expression: body } },
      })

    expect(analyze('Patient.recurse()', 'recurse()')).toMatchObject({
      diagnostics: [],
      result: { types: undefined, single: undefined },
    })
    expect(analyze('Patient.recurse()', '(')).toMatchObject({
      diagnostics: [],
      result: { types: undefined, single: undefined },
    })
  })
})

describe('criteria: the criteria rule on the function', () => {
  const observation = { resourceType: 'Observation', status: 'final', code: { text: 'Weight' } }
  const criterion = (expression: string): Record<string, CustomFunction> => ({
    holds: { expression, criteria: true },
  })
  const run = (expression: string, functions: Record<string, CustomFunction>): unknown[] =>
    evaluate(expression, observation, { functions, model: r4Model })

  it('answers exactly one boolean, whatever the body yields', () => {
    expect(run('holds()', criterion("status = 'final'"))).toEqual([true])
    expect(run('holds()', criterion("status = 'amended'"))).toEqual([false])
    // Empty is false, which is the point: the call chains as a boolean.
    expect(run('holds()', criterion('nothing.here'))).toEqual([false])
    expect(run('holds().not()', criterion('nothing.here'))).toEqual([true])
    // A single non-boolean item is true, per the implicit-exists rule.
    expect(run('holds()', criterion('code.text'))).toEqual([true])
  })

  it('is falsified by dropping the flag: the same body comes back empty', () => {
    expect(evaluate('holds()', observation, { functions: { holds: { expression: 'nothing.here' } } })).toEqual([])
  })

  it('keeps the >1-item error, and still allows a later call', () => {
    const many = criterion('code.text | status')
    expect(() => run('holds()', many)).toThrow('Expected a collection with at most one item, but found 2')
    // The name is removed from activeExpressionFunctions even though the
    // criteria rule threw, so a later call still works.
    expect(run('holds()', criterion("status = 'final'"))).toEqual([true])
  })
})

describe('a declared input type', () => {
  /** Written against a CodeableConcept, in both host-function forms. */
  const asExpression: CustomFunction = {
    expression: '(text | coding.display.first() | coding.first().code).first()',
    signature: { input: { types: ['CodeableConcept'] }, result: { types: ['string'], single: true } },
  }
  const asNative: CustomFunction = {
    minArity: 0,
    maxArity: 0,
    signature: { input: { types: ['CodeableConcept'] } },
    fn: input => input.map(value => (value as { text?: string }).text),
  }
  const patientWith = (concept: unknown) => ({ resourceType: 'Patient', maritalStatus: concept, gender: 'female' })
  const married = patientWith({ text: 'Married' })

  describe.each([
    ['expression-defined', asExpression],
    ['native', asNative],
  ])('%s', (_form, displayText) => {
    const functions = { displayText }
    const run = (expression: string, input: unknown = married): unknown[] =>
      evaluate(expression, input, { functions, model: r4Model })

    it('runs on a focus of the declared type', () => {
      expect(run('maritalStatus.displayText()')).toEqual(['Married'])
    })

    it('throws on a focus that can never be one', () => {
      expect(() => run('gender.displayText()')).toThrow(
        "Function 'displayText' expects FHIR.CodeableConcept as input, but the focus is FHIR.code"
      )
    })

    it('stays silent on an empty focus, without a model, and on types no model describes', () => {
      // Empty is the spec's own propagation, not a mistake.
      expect(run('maritalStatus.text.nothing.displayText()')).toEqual([])
      // No model: nothing to resolve either side of the question against.
      expect(evaluate('gender.displayText()', married, { functions })).toEqual([])
      // A plain JS value carries the Object placeholder, which no model knows.
      expect(
        evaluate('%loose.displayText()', married, { functions, model: r4Model, env: { loose: { a: 1 } } })
      ).toEqual([])
    })

    it('accepts a union focus where one candidate fits', () => {
      // `gender` can never be a CodeableConcept, but maritalStatus can, and the
      // check only fires when no item could possibly fit.
      expect(run('(maritalStatus | gender).displayText()')).toEqual(['Married'])
    })
  })

  it('is falsified by dropping the declaration: the call comes back empty instead', () => {
    const undeclared: CustomFunction = { expression: asExpression.expression as string }
    expect(
      evaluate('gender.displayText()', married, { functions: { displayText: undeclared }, model: r4Model })
    ).toEqual([])
  })

  describe('in the analyzer', () => {
    const functions = { displayText: asExpression }
    const codes = (expression: string, inputType = 'Patient'): string[] =>
      analyzeExpression(expression, { model: r4Model, inputType, functions }).map(d => d.code)

    it('reports a focus that can never hold the declared type', () => {
      expect(codes('gender.displayText()')).toEqual(['input-type'])
      expect(
        analyzeExpression('gender.displayText()', { model: r4Model, inputType: 'Patient', functions })[0]?.message
      ).toBe('displayText() expects FHIR.CodeableConcept as input, found FHIR.code')
    })

    it('stays quiet where it cannot prove anything', () => {
      expect(codes('maritalStatus.displayText()')).toEqual([])
      // A union passes when any candidate fits, and so do iif's branches.
      expect(codes('(maritalStatus | gender).displayText()')).toEqual([])
      expect(codes('iif(true, maritalStatus, gender).displayText()')).toEqual([])
      // An unknown region claims nothing.
      expect(codes('children().displayText()')).toEqual([])
      // Without a model there is nothing to resolve either name against.
      expect(analyzeExpression('gender.displayText()', { functions }).map(d => d.code)).toEqual([])
    })

    it('walks a surplus argument against $this, now that the column has a signature', () => {
      // Declaring an input type gives every column a signature, so an extra
      // argument now takes the checked path. Value arguments analyze against
      // $this, which here is the Patient rather than the call's input.
      const messages = analyzeExpression('maritalStatus.displayText(nope)', {
        model: r4Model,
        inputType: 'Patient',
        functions,
      }).map(d => d.message)
      expect(messages).toEqual([
        "Function 'displayText' expects 0 arguments, got 1",
        "Element 'nope' is not defined on FHIR.Patient",
      ])
    })

    it('ignores declared names this model has never heard of', () => {
      const foreign = { displayText: { ...asExpression, signature: { input: { types: ['Widget'] } } } }
      expect(
        analyzeExpression('gender.displayText()', { model: r4Model, inputType: 'Patient', functions: foreign }).map(
          d => d.code
        )
      ).toEqual([])
    })
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

// Type-level check: host functions receive eagerly evaluated values, so their
// signatures cannot declare analyzer lambda semantics the runtime won't honor.
const invalidSignature: CustomFunction = {
  fn: () => undefined,
  // @ts-expect-error -- 'expression' is a lambda spec; only 'any' and ValueKinds are eager
  signature: { args: ['expression'] },
}
void invalidSignature

// `criteria` coerces an expression body's result. A native function returns
// plain JS values and would ignore it without saying so.
// @ts-expect-error -- criteria belongs to the expression form only
const nativeCriteria: CustomFunction = {
  fn: () => true,
  criteria: true,
}
void nativeCriteria
