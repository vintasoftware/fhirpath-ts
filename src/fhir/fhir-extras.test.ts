import { describe, expect, it } from 'vitest'
import type { EvaluateOptions } from '../api/compile.ts'
import { evaluate } from '../api/evaluate.ts'
import { r4Model } from '../r4/index.ts'
import { validateNarrative } from './html-checks.ts'

const options: EvaluateOptions = { model: r4Model }

const observation = {
  resourceType: 'Observation',
  id: 'o1',
  status: 'final',
  code: { coding: [{ system: 'http://loinc.org', code: '29463-7', display: 'Body weight' }] },
  valueQuantity: { value: 185, unit: 'lbs', system: 'http://unitsofmeasure.org', code: '[lb_av]' },
}

const patient = {
  resourceType: 'Patient',
  id: 'example',
  active: true,
  deceasedBoolean: false,
  birthDate: '1974-12-25',
  _birthDate: {
    id: 'bd',
    extension: [
      { url: 'http://hl7.org/fhir/StructureDefinition/patient-birthTime', valueDateTime: '1974-12-25T14:35:45-05:00' },
    ],
  },
  name: [{ use: 'official', family: 'Chalmers', given: ['Peter', 'James'] }],
  extension: [{ url: 'http://example.org/flag', valueBoolean: true }],
  managingOrganization: { reference: '#org1' },
  contained: [{ resourceType: 'Organization', id: 'org1', name: 'ACME' }],
}

describe('choice element navigation', () => {
  it('resolves value[x] by stem name', () => {
    expect(evaluate('Observation.value.exists()', observation, options)).toEqual([true])
    expect(evaluate('(Observation.value as Quantity).unit', observation, options)).toEqual(['lbs'])
    expect(evaluate('Observation.value.is(Quantity)', observation, options)).toEqual([true])
    expect(evaluate('Patient.deceased', patient, options)).toEqual([false])
    expect(evaluate('Patient.deceased.is(boolean)', patient, options)).toEqual([true])
  })

  it('quantity choice values compare against quantity literals with unit conversion', () => {
    expect(evaluate("Observation.value = 185 '[lb_av]'", observation, options)).toEqual([true])
    expect(evaluate("Observation.value > 80 'kg'", observation, options)).toEqual([true])
    expect(evaluate("Observation.value.comparable(1 'kg')", observation, options)).toEqual([true])
    expect(evaluate("Observation.value.comparable(1 's')", observation, options)).toEqual([false])
  })

  it('model-typed primitives keep their FHIR type; values parse into System representations', () => {
    expect(evaluate('Patient.birthDate is date', patient, options)).toEqual([true])
    // The FHIR type does not answer unqualified or System-qualified System names (testType12/14).
    expect(evaluate('Patient.birthDate is Date', patient, options)).toEqual([false])
    expect(evaluate('Patient.birthDate < @2000-01-01', patient, options)).toEqual([true])
    expect(evaluate('Patient.name.given.ofType(string).count()', patient, options)).toEqual([2])
    expect(evaluate('Patient.name.ofType(HumanName).exists()', patient, options)).toEqual([true])
  })
})

describe('primitive extensions', () => {
  it('extension() reads primitive _field extensions', () => {
    expect(
      evaluate(
        "Patient.birthDate.extension('http://hl7.org/fhir/StructureDefinition/patient-birthTime').value.exists()",
        patient,
        options
      )
    ).toEqual([true])
    expect(evaluate("Patient.birthDate.extension('http://nope').exists()", patient, options)).toEqual([false])
  })

  it('extension() reads complex-value extensions', () => {
    expect(evaluate("Patient.extension('http://example.org/flag').value", patient, options)).toEqual([true])
  })

  it('accepts a FHIR-primitive string as the url argument, not only System.String', () => {
    // implicitRules is a FHIR.uri (System type String); the argument check must
    // go through systemTypeOf, not a strict item.type === System.String.
    const resource = {
      resourceType: 'Patient',
      implicitRules: 'http://example.org/flag',
      extension: [{ url: 'http://example.org/flag', valueBoolean: true }],
    }
    expect(evaluate('Patient.extension(Patient.implicitRules).value', resource, options)).toEqual([true])
  })

  it('id and extension navigate from the _field sibling', () => {
    expect(evaluate('Patient.birthDate.id', patient, options)).toEqual(['bd'])
    expect(evaluate('Patient.birthDate.extension.url', patient, options)).toEqual([
      'http://hl7.org/fhir/StructureDefinition/patient-birthTime',
    ])
  })

  it('a primitive present only through its _field sibling still navigates', () => {
    const resource = { resourceType: 'Patient', _birthDate: { extension: [{ url: 'http://x', valueCode: 'unknown' }] } }
    expect(evaluate('Patient.birthDate.extension.url', resource, options)).toEqual(['http://x'])
    expect(evaluate('Patient.birthDate.hasValue()', resource, options)).toEqual([false])
  })

  it('hasValue/getValue distinguish primitives from complex values', () => {
    expect(evaluate('Patient.birthDate.hasValue()', patient, options)).toEqual([true])
    expect(evaluate('Patient.name.first().hasValue()', patient, options)).toEqual([false])
    expect(evaluate('Patient.birthDate.getValue() = @1974-12-25', patient, options)).toEqual([true])
    expect(evaluate('Patient.name.first().getValue()', patient, options)).toEqual([])
    expect(evaluate('{}.hasValue()', patient, options)).toEqual([])
  })
})

describe('resolve()', () => {
  it('resolves contained references', () => {
    expect(evaluate('Patient.managingOrganization.resolve().name', patient, options)).toEqual(['ACME'])
  })

  it('a bare # resolves to the container', () => {
    const resource = { ...patient, managingOrganization: { reference: '#' } }
    expect(evaluate('Patient.managingOrganization.resolve().id', resource, options)).toEqual(['example'])
  })

  it('resolves bundle-internal references by fullUrl and type/id', () => {
    const bundle = {
      resourceType: 'Bundle',
      entry: [
        { fullUrl: 'http://example.org/Patient/p1', resource: { resourceType: 'Patient', id: 'p1' } },
        {
          fullUrl: 'http://example.org/Observation/obs',
          resource: { resourceType: 'Observation', id: 'obs', subject: { reference: 'Patient/p1' } },
        },
      ],
    }
    expect(evaluate('Bundle.entry.resource.ofType(Observation).subject.resolve().id', bundle, options)).toEqual(['p1'])
    expect(
      evaluate('%bundleRef.resolve().id', bundle, { ...options, env: { bundleRef: 'http://example.org/Patient/p1' } })
    ).toEqual(['p1'])
  })

  it('unresolvable references are empty', () => {
    expect(evaluate("'Patient/elsewhere'.resolve()", patient, options)).toEqual([])
    expect(evaluate("'#missing'.resolve()", patient, options)).toEqual([])
    expect(evaluate('name.first().resolve()', patient, options)).toEqual([])
  })

  it('a relative reference does not match a fullUrl on a different base', () => {
    // fullUrl tail is Patient/123 but the resource id is 999; the resource must
    // confirm the type/id, so this resolves to empty rather than the wrong resource.
    const bundle = {
      resourceType: 'Bundle',
      entry: [
        { fullUrl: 'http://other.org/fhir/Patient/123', resource: { resourceType: 'Patient', id: '999' } },
        {
          fullUrl: 'http://example.org/Observation/o',
          resource: { resourceType: 'Observation', id: 'o', subject: { reference: 'Patient/123' } },
        },
      ],
    }
    expect(evaluate('Bundle.entry.resource.ofType(Observation).subject.resolve().id', bundle, options)).toEqual([])
  })

  it('tolerates malformed bundle entries without crashing', () => {
    const bundle = { resourceType: 'Bundle', entry: [null, { resource: { resourceType: 'Patient', id: 'p' } }] }
    expect(evaluate("'Patient/p'.resolve().id", bundle, options)).toEqual(['p'])
  })
})

describe('FHIR equivalence', () => {
  it('Codings are equivalent on system and code', () => {
    const input = {
      resourceType: 'Observation',
      status: 'final',
      code: {
        coding: [
          { system: 'http://loinc.org', code: '29463-7', display: 'Body weight' },
          { system: 'http://snomed.info/sct', code: '27113001' },
        ],
      },
      valueQuantity: { value: 1, unit: 'kg' },
    }
    // Display differences do not matter for Coding equivalence.
    expect(
      evaluate('Observation.code.coding.first() ~ %other', input, {
        ...options,
        env: { other: { system: 'http://loinc.org', code: '29463-7', display: 'Different Display' } },
      })
    ).toEqual([true])
    expect(
      evaluate('Observation.code.coding.first() ~ %other', input, {
        ...options,
        env: { other: { system: 'http://loinc.org', code: 'other-code' } },
      })
    ).toEqual([false])
    expect(evaluate('Observation.code.coding.first().type().name', input, options)).toEqual(['Coding'])
  })

  it('element ids are ignored by ~ on complex values', () => {
    const withIds = { resourceType: 'Patient', name: [{ id: 'x', family: 'A' }] }
    expect(evaluate('name ~ %other', withIds, { ...options, env: { other: { family: 'A' } } })).toEqual([true])
  })

  it('deferred functions fail with clear messages', () => {
    expect(() => evaluate("code.memberOf('http://vs')", observation, options)).toThrow(
      'memberOf() needs a terminology provider'
    )
    expect(() => evaluate("conformsTo('http://profile')", observation, options)).toThrow(
      'only supports base StructureDefinition urls'
    )
    expect(evaluate("conformsTo('http://hl7.org/fhir/StructureDefinition/Observation')", observation, options)).toEqual(
      [true]
    )
    expect(evaluate("conformsTo('http://hl7.org/fhir/StructureDefinition/Patient')", observation, options)).toEqual([
      false,
    ])
    expect(() => evaluate('checkModifiers()', observation, options)).toThrow('not supported in v1')
  })
})

describe('htmlChecks', () => {
  const valid = '<div xmlns="http://www.w3.org/1999/xhtml"><p>Body <b>weight</b></p></div>'

  it('accepts valid narrative and rejects violations', () => {
    expect(validateNarrative(valid)).toBe(true)
    expect(evaluate('%html.htmlChecks()', undefined, { env: { html: valid } })).toEqual([true])
  })

  it.each([
    ['<div><p>no namespace</p></div>'],
    ['<div xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></div>'],
    ['<div xmlns="http://www.w3.org/1999/xhtml"><p onclick="x()">hi</p></div>'],
    ['<div xmlns="http://www.w3.org/1999/xhtml"><a href="javascript:x()">hi</a></div>'],
    // Browsers entity-decode and skip control characters before resolving the
    // scheme, so smuggled forms of javascript: must fail too.
    ['<div xmlns="http://www.w3.org/1999/xhtml"><a href="java&#115;cript:x()">hi</a></div>'],
    ['<div xmlns="http://www.w3.org/1999/xhtml"><a href="java&#x73;cript:x()">hi</a></div>'],
    ['<div xmlns="http://www.w3.org/1999/xhtml"><a href="jav\tascript:x()">hi</a></div>'],
    ['<div xmlns="http://www.w3.org/1999/xhtml"><a href="\u0001javascript:x()">hi</a></div>'],
    ['<div xmlns="http://www.w3.org/1999/xhtml"><a href="vbscript:x()">hi</a></div>'],
    ['<div xmlns="http://www.w3.org/1999/xhtml"><a href="data:text/html,x">hi</a></div>'],
    ['<div xmlns="http://www.w3.org/1999/xhtml"><img src="data:text/html,x" alt="i"/></div>'],
    // Non-XML named entities (only lt/gt/amp/quot/apos are well-formed) let a
    // browser decode &Tab;/&colon; and execute the URL — the document is not
    // well-formed XHTML, so it must be rejected wherever the entity appears.
    ['<div xmlns="http://www.w3.org/1999/xhtml"><a href="java&Tab;script:x()">hi</a></div>'],
    ['<div xmlns="http://www.w3.org/1999/xhtml"><a href="javascript&colon;x()">hi</a></div>'],
    ['<div xmlns="http://www.w3.org/1999/xhtml"><p>bad &nbsp; entity</p></div>'],
    ['<div xmlns="http://www.w3.org/1999/xhtml"><p>unclosed</div>'],
    ['<div xmlns="http://www.w3.org/1999/xhtml"><p foo="bar">attr</p></div>'],
    ['<p xmlns="http://www.w3.org/1999/xhtml">not a div</p>'],
    ['stray text <div xmlns="http://www.w3.org/1999/xhtml"/>'],
  ])('rejects %s', html => {
    expect(validateNarrative(html)).toBe(false)
  })

  it('accepts void and self-closing elements, comments, and entities', () => {
    expect(
      validateNarrative(
        '<div xmlns="http://www.w3.org/1999/xhtml"><!-- note --><p>a&amp;b<br/></p><hr/><img src="data:image/png;base64,x" alt="i"/></div>'
      )
    ).toBe(true)
  })

  it.each([
    ['https://example.org/page'],
    ['http://example.org'],
    ['mailto:doc@example.org'],
    ['tel:+15551234567'],
    ['urn:uuid:0000'],
    ['relative/path.html'],
    ['#fragment'],
    ['?query=1'],
  ])('accepts inert href %s', href => {
    expect(validateNarrative(`<div xmlns="http://www.w3.org/1999/xhtml"><a href="${href}">x</a></div>`)).toBe(true)
  })

  it('empty input propagates and non-strings are false', () => {
    expect(evaluate('{}.htmlChecks()')).toEqual([])
    expect(evaluate('1.htmlChecks()')).toEqual([false])
  })
})

describe('%resource and %rootResource', () => {
  it('both point at the evaluation root', () => {
    expect(evaluate('%resource.id', patient, options)).toEqual(['example'])
    expect(evaluate('name.where($this.use = %resource.name.first().use).exists()', patient, options)).toEqual([true])
    expect(evaluate('%rootResource.id', patient, options)).toEqual(['example'])
  })
})
