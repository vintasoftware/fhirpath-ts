import { describe, expect, it, vi } from 'vitest'

import type { EvaluateOptions } from '../api/compile.ts'
import { compile } from '../api/compile.ts'
import { evaluate, evaluateAsync } from '../api/evaluate.ts'
import { FhirPathRuntimeError, FhirPathTypeError } from '../errors.ts'
import { r4Model } from '../r4/index.ts'
import type { TerminologyProvider } from '../terminology/provider.ts'

const VS_VITALS = 'http://example.org/ValueSet/vitals'

const observation = {
  resourceType: 'Observation' as const,
  id: 'o1',
  status: 'final' as const,
  code: { coding: [{ system: 'http://loinc.org', code: '29463-7', display: 'Body weight' }] },
}

/**
 * A stub service: 29463-7 is a vital sign; 85354-9 subsumes 8480-6 (a made-up
 * hierarchy for testing). Every call is recorded so tests can assert the replay
 * strategy hits the provider exactly once per distinct request.
 */
function stubProvider(): TerminologyProvider & { calls: string[] } {
  return {
    calls: [],
    async validateVS(valueSet, coded, params) {
      this.calls.push(`validateVS ${String(valueSet)} ${JSON.stringify(coded)}${params ? ` ${params}` : ''}`)
      const code = typeof coded === 'string' ? coded : codeOf(coded)
      if (code === 'unknown-code') {
        return { resourceType: 'Parameters', parameter: [{ name: 'message', valueString: 'not sure' }] }
      }
      return { resourceType: 'Parameters', parameter: [{ name: 'result', valueBoolean: code === '29463-7' }] }
    },
    async validateCS(codeSystem, coded) {
      this.calls.push(`validateCS ${String(codeSystem)} ${JSON.stringify(coded)}`)
      return { resourceType: 'Parameters', parameter: [{ name: 'result', valueBoolean: true }] }
    },
    async subsumes(system, coded1, coded2) {
      this.calls.push(`subsumes ${system} ${JSON.stringify(coded1)} ${JSON.stringify(coded2)}`)
      const a = codeOf(coded1)
      const b = codeOf(coded2)
      if (a === b) {
        return 'equivalent'
      }
      if (a === '85354-9' && b === '8480-6') {
        return 'subsumes'
      }
      if (a === '8480-6' && b === '85354-9') {
        return 'subsumed-by'
      }
      return 'not-subsumed'
    },
    async expand(valueSet) {
      this.calls.push(`expand ${String(valueSet)}`)
      return {
        resourceType: 'ValueSet',
        expansion: { contains: [{ system: 'http://loinc.org', code: '29463-7' }] },
      }
    },
    async lookup(coded, params) {
      this.calls.push(`lookup ${JSON.stringify(coded)}${params ? ` ${params}` : ''}`)
      return {
        resourceType: 'Parameters',
        parameter: [
          { name: 'display', valueString: 'Body weight' },
          {
            name: 'property',
            part: [
              { name: 'code', valueCode: 'itemWeight' },
              { name: 'value', valueDecimal: 3.5 },
            ],
          },
        ],
      }
    },
    async translate(conceptMap, coded) {
      this.calls.push(`translate ${String(conceptMap)} ${JSON.stringify(coded)}`)
      return { resourceType: 'Parameters', parameter: [{ name: 'result', valueBoolean: true }] }
    },
  }
}

function codeOf(coded: unknown): unknown {
  if (typeof coded !== 'object' || coded === null) {
    return undefined
  }
  const value = coded as { code?: unknown; coding?: { code?: unknown }[] }
  return value.code ?? value.coding?.[0]?.code
}

function asyncOptions(terminology: TerminologyProvider): EvaluateOptions {
  return { model: r4Model, terminology, env: { vs: VS_VITALS } }
}

describe('memberOf', () => {
  it('checks a Coding against the value set', async () => {
    const provider = stubProvider()
    await expect(
      evaluateAsync('Observation.code.coding.first().memberOf(%vs)', observation, asyncOptions(provider))
    ).resolves.toEqual([true])
    expect(provider.calls).toEqual([
      `validateVS ${VS_VITALS} {"system":"http://loinc.org","code":"29463-7","display":"Body weight"}`,
    ])
  })

  it('accepts CodeableConcept and code inputs', async () => {
    const provider = stubProvider()
    await expect(evaluateAsync('Observation.code.memberOf(%vs)', observation, asyncOptions(provider))).resolves.toEqual(
      [true]
    )
    await expect(
      evaluateAsync('Observation.status.memberOf(%vs)', observation, asyncOptions(provider))
    ).resolves.toEqual([false])
    expect(provider.calls[1]).toBe(`validateVS ${VS_VITALS} "final"`)
  })

  it('yields empty when the service cannot determine membership', async () => {
    await expect(
      evaluateAsync("'unknown-code'.memberOf(%vs)", observation, asyncOptions(stubProvider()))
    ).resolves.toEqual([])
    // Responses that are not a Parameters resource, or whose result parameter
    // carries no value, also count as "cannot determine".
    const outcome = stubProvider()
    outcome.validateVS = async () => ({ resourceType: 'OperationOutcome' })
    await expect(evaluateAsync('Observation.code.memberOf(%vs)', observation, asyncOptions(outcome))).resolves.toEqual(
      []
    )
    const valueless = stubProvider()
    valueless.validateVS = async () => ({ resourceType: 'Parameters', parameter: [{ name: 'result' }] })
    await expect(
      evaluateAsync('Observation.code.memberOf(%vs)', observation, asyncOptions(valueless))
    ).resolves.toEqual([])
  })

  it('propagates empty inputs and empty urls', async () => {
    const provider = stubProvider()
    const options = asyncOptions(provider)
    await expect(evaluateAsync('Observation.dataAbsentReason.memberOf(%vs)', observation, options)).resolves.toEqual([])
    await expect(evaluateAsync('Observation.code.memberOf({})', observation, options)).resolves.toEqual([])
    expect(provider.calls).toEqual([])
  })

  it('returns empty for multi-item inputs, including in strict mode', async () => {
    const provider = stubProvider()
    await expect(
      evaluateAsync("('a' | 'b').memberOf(%vs)", observation, { ...asyncOptions(provider), strict: true })
    ).resolves.toEqual([])
    expect(provider.calls).toEqual([])
  })

  it('rejects non-coded inputs and non-string urls', async () => {
    const options = asyncOptions(stubProvider())
    await expect(evaluateAsync('true.memberOf(%vs)', observation, options)).rejects.toThrow(
      'memberOf() expects a code, Coding, or CodeableConcept input'
    )
    await expect(evaluateAsync('Observation.code.memberOf(1)', observation, options)).rejects.toThrow(
      'memberOf() expects a String valueset url argument'
    )
  })

  it('hits the provider once per distinct request', async () => {
    const provider = stubProvider()
    await expect(
      evaluateAsync(
        'Observation.code.memberOf(%vs) and Observation.code.memberOf(%vs) and Observation.code.coding.first().memberOf(%vs)',
        observation,
        asyncOptions(provider)
      )
    ).resolves.toEqual([true])
    expect(provider.calls).toHaveLength(2)
  })

  it('fails under sync evaluate() with a pointer to evaluateAsync()', () => {
    expect(() => evaluate('Observation.code.memberOf(%vs)', observation, asyncOptions(stubProvider()))).toThrow(
      'memberOf() is only available with evaluateAsync()'
    )
  })

  it('fails without a terminology provider', async () => {
    await expect(
      evaluateAsync('Observation.code.memberOf(%vs)', observation, { model: r4Model, env: { vs: VS_VITALS } })
    ).rejects.toThrow('memberOf() needs a terminology provider (pass options.terminology)')
  })

  it('fails when the provider lacks the operation', async () => {
    await expect(
      evaluateAsync('Observation.code.memberOf(%vs)', observation, {
        model: r4Model,
        env: { vs: VS_VITALS },
        terminology: {},
      })
    ).rejects.toThrow('the terminology provider does not implement validateVS()')
  })

  it('propagates provider failures', async () => {
    const provider: TerminologyProvider = {
      validateVS: () => Promise.reject(new Error('terminology server unreachable')),
    }
    await expect(
      evaluateAsync('Observation.code.memberOf(%vs)', observation, {
        model: r4Model,
        terminology: provider,
        env: { vs: VS_VITALS },
      })
    ).rejects.toThrow('terminology server unreachable')
  })
})

describe('subsumes / subsumedBy', () => {
  const panel = { system: 'http://loinc.org', code: '85354-9' }
  const systolic = { system: 'http://loinc.org', code: '8480-6' }
  const env = { panel, systolic, other: { system: 'http://snomed.info/sct', code: '271649006' } }

  it('reports subsumption between Codings', async () => {
    const options = { model: r4Model, terminology: stubProvider(), env }
    await expect(evaluateAsync('%panel.subsumes(%systolic)', observation, options)).resolves.toEqual([true])
    await expect(evaluateAsync('%systolic.subsumes(%panel)', observation, options)).resolves.toEqual([false])
    await expect(evaluateAsync('%systolic.subsumedBy(%panel)', observation, options)).resolves.toEqual([true])
    await expect(evaluateAsync('%panel.subsumedBy(%systolic)', observation, options)).resolves.toEqual([false])
    await expect(evaluateAsync('%panel.subsumes(%panel)', observation, options)).resolves.toEqual([true])
    await expect(evaluateAsync('%panel.subsumedBy(%panel)', observation, options)).resolves.toEqual([true])
  })

  it('accepts CodeableConcept inputs, matching any coding pair', async () => {
    const concept = { coding: [{ system: 'http://snomed.info/sct', code: 'x' }, panel] }
    await expect(
      evaluateAsync('%concept.subsumes(%systolic)', observation, {
        model: r4Model,
        terminology: stubProvider(),
        env: { ...env, concept },
      })
    ).resolves.toEqual([true])
  })

  it('leaves different systems indeterminate without asking the provider', async () => {
    const provider = stubProvider()
    await expect(
      evaluateAsync('%panel.subsumes(%other)', observation, { model: r4Model, terminology: provider, env })
    ).resolves.toEqual([])
    await expect(
      evaluateAsync('%panel.subsumedBy(%other)', observation, { model: r4Model, terminology: provider, env })
    ).rejects.toThrow('relationship between different code systems')
    expect(provider.calls).toEqual([])
  })

  it('yields empty for empty operands or codings without system+code', async () => {
    const options = { model: r4Model, terminology: stubProvider(), env }
    await expect(evaluateAsync('{}.subsumes(%panel)', observation, options)).resolves.toEqual([])
    await expect(evaluateAsync('%panel.subsumes({})', observation, options)).resolves.toEqual([])
    await expect(evaluateAsync("'code-string'.subsumedBy(%panel)", observation, options)).resolves.toEqual([])
  })

  it('enforces the single-argument form on coded inputs', async () => {
    await expect(
      evaluateAsync('%panel.subsumes(%systolic, %panel, %systolic)', observation, {
        model: r4Model,
        terminology: stubProvider(),
        env,
      })
    ).rejects.toThrow("Function 'subsumes' expects 1 argument, got 3 arguments")
  })

  it('keeps unknown provider outcomes and non-singleton operands empty', async () => {
    const provider = stubProvider()
    provider.subsumes = async () => undefined
    const options = { model: r4Model, terminology: provider, env }
    await expect(evaluateAsync('%panel.subsumes(%systolic)', observation, options)).resolves.toEqual([])
    await expect(
      evaluateAsync('(%panel | %systolic).subsumedBy(%panel)', observation, { ...options, strict: true })
    ).resolves.toEqual([])
    await expect(evaluateAsync('%panel.subsumes(%panel | %systolic)', observation, options)).resolves.toEqual([])
    await expect(
      evaluateAsync('%missing.subsumes(%panel)', observation, { ...options, env: { ...env, missing: { code: 'x' } } })
    ).resolves.toEqual([])
  })
})

describe('%terminologies API', () => {
  const coding = { system: 'http://loinc.org', code: '29463-7' }
  const env = { coding, vs: VS_VITALS }

  it.each([
    ['expand', ['%vs']],
    ['lookup', ['%coding']],
    ['validateVS', ['%vs', '%coding']],
    ['validateCS', ["'http://loinc.org'", '%coding']],
    ['subsumes', ["'http://loinc.org'", '%coding', '%coding']],
    ['translate', ["'urn:map'", '%coding']],
  ])('%s returns empty for invalid arguments without calling the provider', async (name, required) => {
    const provider = stubProvider()
    const options = { model: r4Model, terminology: provider, env }
    const args = [...required, "''"]
    for (let index = 0; index < args.length; index++) {
      for (const invalid of ['{}', "('a' | 'b')", 'true', '%resource']) {
        const changed = args.with(index, invalid)
        await expect(
          evaluateAsync(`%terminologies.${name}(${changed.join(', ')})`, observation, options)
        ).resolves.toEqual([])
      }
    }
    expect(provider.calls).toEqual([])
  })

  it('passes resource arguments through and accepts an explicit empty string for params', async () => {
    const expand = vi.fn(async (valueSet: unknown) => valueSet)
    const valueSet = { resourceType: 'ValueSet', url: VS_VITALS }
    await expect(
      evaluateAsync(
        "%terminologies.expand(%vs, '').url",
        {},
        {
          model: r4Model,
          terminology: { expand },
          env: { vs: valueSet },
        }
      )
    ).resolves.toEqual([VS_VITALS])
    expect(expand).toHaveBeenCalledWith(valueSet, '')
  })

  it('rejects a typed Quantity and CodeableConcept where a Coding is required', async () => {
    const provider = stubProvider()
    const input = { ...observation, valueQuantity: { value: 1, system: 'urn:units', code: 'u' } }
    const options = { model: r4Model, terminology: provider }
    await expect(evaluateAsync('%terminologies.lookup(%resource.value)', input, options)).resolves.toEqual([])
    await expect(evaluateAsync("%terminologies.translate('urn:map', %resource.code)", input, options)).resolves.toEqual(
      []
    )
    await expect(
      evaluateAsync("%terminologies.subsumes('urn:codes', %resource.code, 'a')", input, options)
    ).resolves.toEqual([])
    expect(provider.calls).toEqual([])
  })

  it('validateVS returns the Parameters resource', async () => {
    const provider = stubProvider()
    await expect(
      evaluateAsync("%terminologies.validateVS(%vs, %coding).parameter.where(name = 'result').value", observation, {
        model: r4Model,
        terminology: provider,
        env,
      })
    ).resolves.toEqual([true])
    expect(provider.calls).toEqual([`validateVS ${VS_VITALS} ${JSON.stringify(coding)}`])
  })

  it('validateCS, translate, lookup, and expand map onto the provider', async () => {
    const provider = stubProvider()
    const options = { model: r4Model, terminology: provider, env }
    await expect(
      evaluateAsync("%terminologies.validateCS('http://loinc.org', %coding).exists()", observation, options)
    ).resolves.toEqual([true])
    await expect(
      evaluateAsync("%terminologies.translate('http://example.org/cm', %coding).exists()", observation, options)
    ).resolves.toEqual([true])
    await expect(
      evaluateAsync("%terminologies.lookup(%coding).parameter.where(name = 'display').value", observation, options)
    ).resolves.toEqual(['Body weight'])
    await expect(
      evaluateAsync('%terminologies.expand(%vs).expansion.contains.code', observation, options)
    ).resolves.toEqual(['29463-7'])
    expect(provider.calls).toEqual([
      `validateCS http://loinc.org ${JSON.stringify(coding)}`,
      `translate http://example.org/cm ${JSON.stringify(coding)}`,
      `lookup ${JSON.stringify(coding)}`,
      `expand ${VS_VITALS}`,
    ])
  })

  it('passes the trailing params string through', async () => {
    const provider = stubProvider()
    await expect(
      evaluateAsync("%terminologies.lookup(%coding, 'date=2011-03-04').exists()", observation, {
        model: r4Model,
        terminology: provider,
        env,
      })
    ).resolves.toEqual([true])
    expect(provider.calls).toEqual([`lookup ${JSON.stringify(coding)} date=2011-03-04`])
  })

  it('subsumes on %terminologies returns the outcome code', async () => {
    const options = { model: r4Model, terminology: stubProvider(), env: { ...env, systolic: { code: '8480-6' } } }
    await expect(
      evaluateAsync("%terminologies.subsumes('http://loinc.org', %coding, %coding)", observation, options)
    ).resolves.toEqual(['equivalent'])
    await expect(
      evaluateAsync(
        "%terminologies.subsumes('http://loinc.org', %coding, %systolic, 'version=2.74')",
        observation,
        options
      )
    ).resolves.toEqual(['not-subsumed'])
    await expect(
      evaluateAsync("%terminologies.subsumes('http://loinc.org', {}, %coding)", observation, options)
    ).resolves.toEqual([])
    await expect(
      evaluateAsync("%terminologies.subsumes('http://loinc.org', %coding)", observation, options)
    ).rejects.toThrow("Function 'subsumes' expects 3 to 4 arguments, got 2 arguments")
  })

  it('yields empty when a required argument is empty or the provider returns nothing', async () => {
    const provider = stubProvider()
    provider.expand = async () => undefined
    const options = { model: r4Model, terminology: provider, env }
    await expect(evaluateAsync('%terminologies.validateVS({}, %coding)', observation, options)).resolves.toEqual([])
    await expect(evaluateAsync('%terminologies.expand(%vs)', observation, options)).resolves.toEqual([])
  })

  it('is only available on %terminologies', async () => {
    await expect(
      evaluateAsync('Observation.code.lookup(%coding)', observation, {
        model: r4Model,
        terminology: stubProvider(),
        env,
      })
    ).rejects.toThrow('lookup() is only available on %terminologies')
  })

  it('%terminologies is undefined without a provider', () => {
    expect(() => evaluate('%terminologies', observation, { model: r4Model })).toThrow(
      'Undefined environment variable %terminologies'
    )
  })
})

describe('weight', () => {
  it('preserves Coding versions in lookup requests and their cache keys', async () => {
    const codes = ['1', '2', '1'].map(version => ({ system: 'urn:score', code: 'a', version }))
    const lookup = vi.fn(async (coded: unknown) => ({
      resourceType: 'Parameters',
      parameter: [
        {
          name: 'property',
          part: [
            { name: 'code', valueCode: 'itemWeight' },
            { name: 'value', valueDecimal: Number((coded as { version: string }).version) },
          ],
        },
      ],
    }))
    await expect(
      evaluateAsync(
        'code.coding.weight()',
        { ...observation, code: { coding: codes } },
        {
          model: r4Model,
          terminology: { lookup },
        }
      )
    ).resolves.toEqual([1, 2, 1])
    expect(lookup.mock.calls.map(([coded]) => coded)).toEqual(codes.slice(0, 2))
  })

  it('does not request terminology weights for a typed Quantity', async () => {
    const provider = stubProvider()
    const input = { ...observation, valueQuantity: { value: 1, system: 'urn:units', code: 'u' } }
    await expect(evaluateAsync('value.weight()', input, { model: r4Model, terminology: provider })).resolves.toEqual([])
    expect(evaluate('value.weight()', input, { model: r4Model })).toEqual([])
    expect(provider.calls).toEqual([])
  })

  it('falls back to a CodeSystem $lookup through the provider', async () => {
    const provider = stubProvider()
    const coding = { system: 'http://loinc.org', code: '29463-7' }
    await expect(
      evaluateAsync('%x.weight()', observation, { model: r4Model, terminology: provider, env: { x: coding } })
    ).resolves.toEqual([3.5])
    expect(provider.calls).toEqual([`lookup {"system":"http://loinc.org","code":"29463-7"} property=itemWeight`])
  })

  it('yields empty when the lookup has no itemWeight property', async () => {
    const provider = stubProvider()
    provider.lookup = async () => ({ resourceType: 'Parameters', parameter: [{ name: 'display', valueString: 'x' }] })
    await expect(
      evaluateAsync('%x.weight()', observation, {
        model: r4Model,
        terminology: provider,
        env: { x: { system: 'http://loinc.org', code: 'a' } },
      })
    ).resolves.toEqual([])
  })

  it('fails unavailable and invalid CodeSystem weights instead of lowering a score', async () => {
    const provider = stubProvider()
    const options = { model: r4Model, terminology: provider, env: { x: { system: 'urn:codes', code: 'a' } } }
    for (const response of [undefined, { resourceType: 'OperationOutcome' }]) {
      provider.lookup = async () => response
      await expect(evaluateAsync('%x.weight().sum()', observation, options)).rejects.toThrow(
        'cannot resolve the CodeSystem'
      )
    }
    provider.lookup = async () => ({
      resourceType: 'Parameters',
      parameter: [
        {
          name: 'property',
          part: [
            { name: 'code', valueCode: 'itemWeight' },
            { name: 'value', valueString: 'bad' },
          ],
        },
      ],
    })
    await expect(evaluateAsync('%x.weight()', observation, options)).rejects.toThrow('numeric CodeSystem itemWeight')
  })

  it('needs a provider when no extension answers', () => {
    expect(() =>
      evaluate('%x.weight()', observation, { model: r4Model, env: { x: { system: 's', code: 'c' } } })
    ).toThrow('weight() needs a terminology provider (pass options.terminology)')
  })
})

describe('evaluateAsync', () => {
  it('behaves like evaluate() for expressions without async functions', async () => {
    await expect(
      evaluateAsync('Patient.name.given', { resourceType: 'Patient', name: [{ given: ['Ann'] }] }, { model: r4Model })
    ).resolves.toEqual(['Ann'])
    await expect(compile('1 + 1').evaluateAsync()).resolves.toEqual([2])
  })

  it('keeps the initial clock when a provider completes on a later date', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-08T10:00:00Z'))
      const provider: TerminologyProvider = {
        async validateVS() {
          vi.setSystemTime(new Date('2099-01-01T00:00:00Z'))
          return { resourceType: 'Parameters', parameter: [{ name: 'result', valueBoolean: true }] }
        },
      }
      await expect(
        evaluateAsync(
          'Observation.code.memberOf(%vs) and now() < @2027-01-01T00:00:00Z',
          observation,
          asyncOptions(provider)
        )
      ).resolves.toEqual([true])
    } finally {
      vi.useRealTimers()
    }
  })

  it('emits trace output once despite replays', async () => {
    const traces: string[] = []
    await evaluateAsync("Observation.code.trace('code').memberOf(%vs).trace('member')", observation, {
      ...asyncOptions(stubProvider()),
      trace: name => traces.push(name),
    })
    expect(traces).toEqual(['code', 'member'])
  })

  it('drops trace output from failed evaluations', async () => {
    const traces: string[] = []
    await expect(
      evaluateAsync("Observation.code.trace('code').memberOf(1)", observation, {
        ...asyncOptions(stubProvider()),
        trace: name => traces.push(name),
      })
    ).rejects.toThrow(FhirPathTypeError)
    expect(traces).toEqual([])
  })

  it('works through compile() and typed evaluation', async () => {
    const compiled = compile('Observation.code.memberOf(%vs)')
    const typed = await compiled.evaluateTypedAsync(observation, asyncOptions(stubProvider()))
    expect(typed).toEqual([{ type: 'System.Boolean', value: true }])
  })

  it('still surfaces runtime errors', async () => {
    await expect(evaluateAsync('(1 | 2).single()', observation, {})).rejects.toThrow(FhirPathRuntimeError)
  })

  it('evaluates async variables and expression functions with strict checking', async () => {
    const provider = stubProvider()
    await expect(
      evaluateAsync('%member and checkCode()', observation, {
        ...asyncOptions(provider),
        strict: true,
        vars: { member: 'code.memberOf(%vs)' },
        functions: {
          checkCode: {
            expression: 'code.memberOf(%vs)',
            signature: { result: { types: ['System.Boolean'], single: true } },
          },
        },
      })
    ).resolves.toEqual([true])
    expect(provider.calls).toHaveLength(1)
    await expect(
      evaluateAsync('%terminologies.expand(%vs).exists()', observation, { ...asyncOptions(provider), strict: true })
    ).resolves.toEqual([true])
    await expect(
      compile('missing', 'Observation').evaluateAsync(observation, { ...asyncOptions(provider), strict: true })
    ).rejects.toThrow('Strict evaluation failed')
  })

  it('isolates async caches between concurrent calls and lazy branches', async () => {
    const yes = stubProvider()
    const no = stubProvider()
    no.validateVS = async () => ({ resourceType: 'Parameters', parameter: [{ name: 'result', valueBoolean: false }] })
    const expression = 'code.memberOf(%vs)'
    expect(
      await Promise.all([
        evaluateAsync(expression, observation, asyncOptions(yes)),
        evaluateAsync(expression, observation, asyncOptions(no)),
      ])
    ).toEqual([[true], [false]])
    await expect(
      evaluateAsync('iif(false, code.memberOf(%vs), true)', observation, { model: r4Model, env: { vs: VS_VITALS } })
    ).resolves.toEqual([true])
  })

  it('protects a configured terminology service from host variable overrides', async () => {
    const options = asyncOptions(stubProvider())
    await expect(
      evaluateAsync('%terminologies', observation, { ...options, env: { terminologies: {} } })
    ).rejects.toThrow('Cannot override %terminologies')
    await expect(
      evaluateAsync('%terminologies', observation, { ...options, vars: { terminologies: '{}' } })
    ).rejects.toThrow('Cannot override the environment variable')
  })
})
