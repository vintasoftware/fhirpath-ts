import { describe, expect, expectTypeOf, it } from 'vitest'

import { analyzeExpressionDetailed, type DeclaredFunction, type DeclaredVariable } from '../analyzer/analyze.ts'
import { OPERATOR_RESULT_RULES, TYPE_OPERATOR_RESULT_RULES } from '../analyzer/operator-rules.ts'
import { FUNCTION_SIGNATURES } from '../analyzer/signatures.ts'
import { compile } from '../api/compile.ts'
import { parse } from '../parser/parser.ts'
import type { Organization, Practitioner, PractitionerRole } from '../r4/generated/type-maps.ts'
import { r4Model } from '../r4/index.ts'
import { loadCorpus, runCorpusTest } from '../testing/fhirpathjs-harness.ts'
import { loadOfficialSuite, runOfficialTest } from '../testing/official-harness.ts'
import { INFERENCE_CAPABILITIES } from './capability-registry.ts'
import { RESOLVED_INFERENCE_CAPABILITIES } from './generated/capabilities.ts'
import type {} from './generated/capability-assertions.types.ts'
import type { FhirpathResult, FhirpathResultIn } from './infer.ts'

const patient = {
  resourceType: 'Patient',
  name: [{ family: 'Chalmers', given: ['Peter', 'James'] }, { given: ['Jim'] }],
} as const

const observation = {
  resourceType: 'Observation',
  valueQuantity: { value: 80, unit: 'kg' },
} as const

describe('type-inference capability registry', () => {
  it('has unique ids, resolved sources, parseable positives, and companions', () => {
    expect(new Set(Object.keys(INFERENCE_CAPABILITIES)).size).toBe(Object.keys(INFERENCE_CAPABILITIES).length)
    expect(Object.keys(RESOLVED_INFERENCE_CAPABILITIES)).toEqual(Object.keys(INFERENCE_CAPABILITIES))
    for (const [id, capability] of Object.entries(RESOLVED_INFERENCE_CAPABILITIES)) {
      expect(() => parse(capability.expression), id).not.toThrow()
      expect(capability.degradation, id).not.toBe(capability.expression)
      expect(capability.composition, id).not.toBe(capability.expression)
    }
  })

  it('has an exact capability for every literal, operator, and adjacent precedence boundary', () => {
    const ids = new Set(Object.keys(INFERENCE_CAPABILITIES))
    for (const literal of [
      'empty',
      'boolean',
      'integer',
      'long',
      'decimal',
      'string',
      'date',
      'date-time',
      'time',
      'quantity',
    ]) {
      expect(ids.has(`literal.${literal}`), literal).toBe(true)
    }
    const operatorIds: Record<keyof typeof OPERATOR_RESULT_RULES, string> = {
      '*': 'operator.multiply',
      '/': 'operator.divide',
      div: 'operator.div',
      mod: 'operator.mod',
      '+': 'operator.add',
      '-': 'operator.subtract',
      '&': 'operator.concatenate',
      '|': 'operator.union',
      '<': 'operator.less-than',
      '>': 'operator.greater-than',
      '<=': 'operator.less-or-equal',
      '>=': 'operator.greater-or-equal',
      '=': 'operator.equal',
      '~': 'operator.equivalent',
      '!=': 'operator.not-equal',
      '!~': 'operator.not-equivalent',
      in: 'operator.in',
      contains: 'operator.contains',
      and: 'operator.and',
      or: 'operator.or',
      xor: 'operator.xor',
      implies: 'operator.implies',
    }
    expect(Object.keys(operatorIds).sort()).toEqual(Object.keys(OPERATOR_RESULT_RULES).sort())
    for (const [operator, id] of Object.entries(operatorIds)) expect(ids.has(id), operator).toBe(true)
    for (const operator of Object.keys(TYPE_OPERATOR_RESULT_RULES))
      expect(ids.has(`operator.${operator}`), operator).toBe(true)
    expect(ids.has('operator.unary-plus')).toBe(true)
    expect(ids.has('operator.unary-minus')).toBe(true)
    for (const boundary of [
      'call-dot',
      'dot-index',
      'index-unary',
      'unary-multiplicative',
      'multiplicative-additive',
      'additive-type',
      'type-union',
      'union-comparison',
      'comparison-equality',
      'equality-membership',
      'membership-and',
      'and-or',
      'or-implies',
    ]) {
      expect(ids.has(`precedence.${boundary}`), boundary).toBe(true)
    }
  })

  it('has an exact capability for every built-in and scope form', () => {
    const ids = new Set(Object.keys(INFERENCE_CAPABILITIES))
    for (const name of Object.keys(FUNCTION_SIGNATURES)) expect(ids.has(`builtin.${name}`), name).toBe(true)
    for (const scope of [
      'this',
      'index',
      'total',
      'nested-frame-restore',
      'define-variable-input',
      'define-variable-value',
      'nested-binding-restore',
      'multiple-definition-fallback',
      'operator-fork',
      'argument-fork',
    ]) {
      expect(ids.has(`scope.${scope}`), scope).toBe(true)
    }
    for (const variable of ['context-root', 'resource-root', 'root-resource', 'builtin-constant']) {
      expect(ids.has(`variable.${variable}`), variable).toBe(true)
    }
    for (const reference of ['generated-targets', 'state-preservation']) {
      expect(ids.has(`reference.${reference}`), reference).toBe(true)
    }
    for (const route of [
      'environment',
      'variable',
      'function-signature',
      'function-body',
      'function-local-overlay',
      'reference-targets',
    ]) {
      expect(ids.has(`host-context.${route}`), route).toBe(true)
    }
  })

  it('records analyzer agreement for model-backed baseline cases', () => {
    for (const [id, capability] of Object.entries(RESOLVED_INFERENCE_CAPABILITIES)) {
      const variables =
        'context' in capability && 'variables' in capability.context
          ? mutableVariables(capability.context.variables)
          : undefined
      const declaredFunctions =
        'context' in capability && 'functions' in capability.context
          ? mutableFunctions(capability.context.functions as Readonly<Record<string, DeclaredFunction>>)
          : undefined
      const inputType =
        'input' in capability && typeof capability.input === 'string'
          ? capability.input
          : 'inputType' in capability && typeof capability.inputType === 'string'
            ? capability.inputType
            : undefined
      const result = analyzeExpressionDetailed(capability.expression, {
        model: r4Model,
        ...(inputType !== undefined && { inputType }),
        ...(variables !== undefined && { variables }),
        ...(declaredFunctions !== undefined && { functions: declaredFunctions }),
      }).result
      expect(result, id).toEqual(capability.analyzer)
    }
  })

  it('runs every stable reference or manual runtime case', () => {
    for (const [id, capability] of Object.entries(RESOLVED_INFERENCE_CAPABILITIES)) {
      if (!capability.runtime) continue
      if ('reference' in capability) {
        if (capability.reference.kind === 'official') {
          const groups = loadOfficialSuite(capability.reference.suite)
          const group = groups[capability.reference.groupIndex]
          const test = group?.tests[capability.reference.testIndex]
          expect(group, id).toBeDefined()
          expect(test, id).toBeDefined()
          expect(runOfficialTest(capability.reference.suite, test!, group!.name), id).toBeUndefined()
        } else {
          const corpus = loadCorpus(capability.reference.corpus)
          const file = corpus[capability.reference.file]
          const test = file?.tests[capability.reference.testIndex]
          const expression = Array.isArray(test?.expression)
            ? test.expression[capability.reference.expressionIndex]
            : test?.expression
          expect(file, id).toBeDefined()
          expect(test, id).toBeDefined()
          expect(runCorpusTest(file!, test!, expression as string), id).toBeUndefined()
        }
        continue
      }
      expect(runManualCapability(id, capability.expression), id).toBeUndefined()
    }
  })

  it('keeps lambda frames, local variables, and Reference targets precise', () => {
    expectTypeOf<FhirpathResult<'Patient.name.select($this.family)'>>().toEqualTypeOf<string[]>()
    expectTypeOf<FhirpathResult<'Patient.name.select($index)'>>().toEqualTypeOf<number[]>()
    expectTypeOf<FhirpathResult<"Patient.name.aggregate($total.toString(), '')">>().toEqualTypeOf<string[]>()
    expectTypeOf<FhirpathResult<'Patient.name.select(given.select($this.substring(1)) | family)'>>().toEqualTypeOf<
      string[]
    >()
    expectTypeOf<FhirpathResult<"Patient.name.first().defineVariable('n').select(%n.family)">>().toEqualTypeOf<
      string[]
    >()
    expectTypeOf<
      FhirpathResult<"Patient.name.first().defineVariable('n').select(given.select(%n.family))">
    >().toEqualTypeOf<string[]>()
    expectTypeOf<FhirpathResult<"defineVariable('a').defineVariable('b')">>().toEqualTypeOf<unknown[]>()
    expectTypeOf<FhirpathResult<"Patient.defineVariable('left').active | %left">>().toEqualTypeOf<unknown[]>()
    expectTypeOf<FhirpathResultIn<'%context.name.given', 'Patient'>>().toEqualTypeOf<string[]>()
    expectTypeOf<FhirpathResult<'Patient.generalPractitioner.where($this.exists())[0].resolve()'>>().toEqualTypeOf<
      (Organization | Practitioner | PractitionerRole)[]
    >()
  })
})

function runManualCapability(id: string, expression: string): string | undefined {
  const cases: Record<string, { input: unknown; env?: Record<string, unknown>; expected: unknown[] }> = {
    'path.indexer': { input: patient, expected: [patient.name[0]] },
    'path.choice-stem': { input: observation, expected: [observation.valueQuantity] },
    'group.navigation': { input: patient, expected: ['Peter', 'James', 'Jim'] },
    'union.navigation': { input: patient, expected: ['Peter', 'James', 'Jim', 'Chalmers'] },
    'function.input': { input: patient, expected: [patient.name[0]] },
    'variable.opaque-fixed': { input: patient, env: { rowIndex: 3 }, expected: ['3'] },
    'syntax.trivia': { input: patient, expected: [...patient.name] },
    'syntax.delimited-identifier': { input: patient, expected: [...patient.name] },
    'precedence.call-dot': { input: patient, expected: ['Peter', 'James'] },
    'precedence.dot-index': { input: patient, expected: ['Peter', 'James'] },
    'precedence.index-unary': { input: patient, expected: [-5] },
    'precedence.unary-multiplicative': { input: undefined, expected: [-2] },
    'precedence.multiplicative-additive': { input: undefined, expected: [7] },
    'precedence.additive-type': { input: undefined, expected: [true] },
    'precedence.type-union': { input: undefined, expected: [1, true] },
    'precedence.union-comparison': { input: undefined, expected: [true] },
    'precedence.comparison-equality': { input: undefined, expected: [true] },
    'precedence.equality-membership': { input: undefined, expected: [false] },
    'precedence.membership-and': { input: undefined, expected: [true] },
    'precedence.and-or': { input: undefined, expected: [true] },
    'precedence.or-implies': { input: undefined, expected: [true] },
  }
  const fixture = cases[id]
  if (fixture === undefined) return `missing manual runtime fixture for ${id}`
  const actual = compile(expression).evaluate(fixture.input, {
    model: r4Model,
    ...(fixture.env !== undefined && { env: fixture.env }),
  })
  return JSON.stringify(actual) === JSON.stringify(fixture.expected)
    ? undefined
    : `got ${JSON.stringify(actual)}, expected ${JSON.stringify(fixture.expected)}`
}

function mutableVariables(
  variables:
    Readonly<Record<string, { types?: readonly string[]; single?: boolean; targets?: readonly string[] }>> | undefined
): Record<string, DeclaredVariable> | undefined {
  if (variables === undefined) return undefined
  return Object.fromEntries(
    Object.entries(variables).map(([name, declaration]) => [
      name,
      {
        ...(declaration.types !== undefined && { types: [...declaration.types] }),
        ...(declaration.single !== undefined && { single: declaration.single }),
        ...(declaration.targets !== undefined && { targets: [...declaration.targets] }),
      },
    ])
  )
}

function mutableFunctions(
  functions: Readonly<Record<string, DeclaredFunction>> | undefined
): Record<string, DeclaredFunction> | undefined {
  return functions === undefined ? undefined : { ...functions }
}
