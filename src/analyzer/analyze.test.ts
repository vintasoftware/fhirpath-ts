import { describe, expect, it } from 'vitest'

import { r4Model } from '../r4/index.ts'
import { analyzeExpression, analyzeExpressionDetailed, type AnalyzerDiagnostic, analyzeSite } from './analyze.ts'

const options = { model: r4Model, inputType: 'Patient' }

function codes(expression: string, analyzeOptions: Parameters<typeof analyzeExpression>[1] = options): string[] {
  return analyzeExpression(expression, analyzeOptions).map(diagnostic => diagnostic.code)
}

function messages(expression: string, analyzeOptions: Parameters<typeof analyzeExpression>[1] = options): string[] {
  return analyzeExpression(expression, analyzeOptions).map(diagnostic => diagnostic.message)
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
    // The empty literal is statically at most one item, so it satisfies singleton
    // operands (spec-legal; regression for the analyzer treating {} as a collection).
    ['{} + 1'],
    ['{} and true'],
    ['{} = 1'],
    // System.Quantity's components navigate, like the runtime's raw {value, unit} read.
    ["(1.5 'kg').value + 1"],
    ["(1.5 'kg').unit.length()"],
  ])('%s', expression => {
    expect(analyzeExpression(expression, options)).toEqual([])
  })
})

describe('spec §11 rules', () => {
  it('flags unknown elements, including choice-key misuse', () => {
    expect(codes('Patient.nope')).toEqual(['unknown-element'])
    expect(codes("(1 'kg').nope")).toEqual(['unknown-element'])
    expect(codes('Observation.valueQuantity.unit', { model: r4Model, inputType: 'Observation' })).toEqual([
      'unknown-element',
    ])
    expect(codes('Patient.name.gven')).toEqual(['unknown-element'])
    expect(codes('Patient.name.active')).toEqual(['unknown-element'])
  })

  it('suggests the closest name for a mistyped element', () => {
    expect(messages('Patient.name.gven')).toEqual([
      "Element 'gven' is not defined on FHIR.HumanName — did you mean 'given'?",
    ])
    expect(messages('Patient.name.active')).toEqual(["Element 'active' is not defined on FHIR.HumanName"])
    expect(messages('Patient.nome')).toEqual(["Element 'nome' is not defined on FHIR.Patient — did you mean 'name'?"])
    // No suggestion when nothing is a plausible typo, and the choice hint wins over it.
    expect(messages('Patient.nope')).toEqual(["Element 'nope' is not defined on FHIR.Patient"])
    expect(messages('Observation.valueQuantity', { model: r4Model, inputType: 'Observation' })).toEqual([
      "Element 'valueQuantity' is not defined on FHIR.Observation; choice elements use their stem name",
    ])
  })

  it('suggests the closest name for a mistyped function', () => {
    expect(messages('Patient.name.given.lengthx()')).toEqual([
      "Unrecognized function 'lengthx' — did you mean 'length'?",
    ])
    expect(messages('Patient.name.frobnicate()')).toEqual(["Unrecognized function 'frobnicate'"])
  })

  it('spells out how to fix a singleton misuse', () => {
    expect(messages('Patient.name.given.substring(1)')).toEqual([
      'substring() expects a single item as input, but this is a collection (spec §11) — narrow it to one item with first(), last(), or single()',
    ])
  })

  it('names both types in an incompatible equality', () => {
    expect(messages('Patient.gender = 5')).toEqual(['String and Numeric operands can never be equal (spec §11)'])
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
    // & and the comparison operators throw on multi-item at runtime, so the
    // analyzer must flag them too (they previously slipped through).
    expect(codes("Patient.name.given & 'x'")).toEqual(['singleton-required'])
    expect(codes("Patient.name.given < 'x'")).toEqual(['singleton-required'])
    expect(codes('Patient.name.given >= 1')).toContain('singleton-required')
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
    expect(codes("children().defineVariable('var').select(%var.anything.goes)")).toEqual([])
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
    expect(codes("'5'.toLong() > 4")).toEqual([])
    expect(codes("'2014'.toDate() < today()")).toEqual([])
    expect(codes("'2014'.toDateTime().monthOf()")).toEqual([])
    expect(codes("'10:00'.toTime().hourOf()")).toEqual([])
    expect(codes('now().timeOf() > @T00:00')).toEqual([])
    expect(codes("1.toQuantity('mg').comparable(1 'g')")).toEqual([])
  })
})

describe('coverage completion', () => {
  it('literal states for every literal kind', () => {
    expect(codes('@2014T < now()')).toEqual([])
    expect(codes('@T10:00 > timeOfDay() or true')).toEqual([])
    expect(codes("1 'mg' + 1 'mg'")).toEqual([])
    expect(codes("2 'mg' * 2")).toEqual([])
    expect(codes('4 div 2 + 4 mod 2')).toEqual([])
    expect(codes('{} = {}')).toEqual([])
  })

  it('inputType without a model stays unresolved but harmless', () => {
    expect(analyzeExpression('name.given', { inputType: 'Patient' })).toEqual([])
  })

  it('$this at the root uses the input state', () => {
    expect(codes('$this.name.count() >= 0')).toEqual([])
  })

  it('a type-name root that does not match the input is an unknown element', () => {
    expect(codes('Group.member')).toEqual(['unknown-element'])
  })

  it('unknown functions still walk their arguments', () => {
    expect(codes('frobnicate(name.nope)').sort()).toEqual(['unknown-element', 'unknown-function'])
  })

  it('malformed and misnamespaced type arguments', () => {
    expect(codes('1.is(exists().x)')).toEqual(['unknown-type'])
    expect(codes('1.ofType(a.exists())')).toEqual(['unknown-type'])
    expect(codes('1 is Nope.Thing')).toEqual(['unknown-type'])
    expect(codes("defineVariable('v').select(%v is Patient)")).toEqual([])
  })

  it('contains demands a single right operand', () => {
    expect(codes("'a' contains Patient.name.given")).toEqual(['singleton-required'])
    expect(codes("Patient.name.given contains 'a'")).toEqual([])
  })

  it('same-kind unions keep their kind', () => {
    expect(codes('(Patient.name.given | Patient.name.family).count() > 0')).toEqual([])
    expect(codes('(Patient.name.given | Patient.name.family).first().length()')).toEqual([])
  })

  it('boolean comparisons are flagged', () => {
    expect(codes('true < false')).toEqual(['operand-type'])
  })
})

describe('type-name roots on non-resource inputs', () => {
  const datatype = { model: r4Model, inputType: 'CodeableConcept' }

  it('flags a root naming the datatype input, which the runtime navigates to empty', () => {
    const diagnostics = analyzeExpression('CodeableConcept.text', datatype)
    expect(diagnostics.map(d => [d.severity, d.code])).toEqual([['error', 'datatype-root']])
    expect(diagnostics[0]?.message).toBe(
      "'CodeableConcept' is not a resource type, and a type-name root matches only a resource's resourceType, so this always evaluates to empty — navigate from the input with a relative path"
    )
  })

  it('flags a root naming a non-resource supertype of the input', () => {
    expect(codes('Element.id', datatype)).toEqual(['datatype-root'])
  })

  it('keeps checking the rest of the path after the flagged root', () => {
    expect(codes('CodeableConcept.nope', datatype).sort()).toEqual(['datatype-root', 'unknown-element'])
  })

  it('relative paths on datatype inputs stay diagnostic-free', () => {
    // CodeableConceptDTO's displayText column (dogfood) — the recommended style.
    expect(codes('(text | coding.display.first() | coding.first().code).first()', datatype)).toEqual([])
  })

  it('resource-name roots on resource inputs stay accepted, including supertypes', () => {
    expect(codes('Patient.name.given', options)).toEqual([])
    expect(codes('Resource.id', options)).toEqual([])
    expect(codes('DomainResource.contained.count()', options)).toEqual([])
  })

  it('a datatype name mid-chain still self-matches, like the runtime', () => {
    // After model navigation items carry their model types, so the runtime's
    // type-name match succeeds there — only the raw root input lacks one.
    expect(codes('code.CodeableConcept.text', { model: r4Model, inputType: 'Observation' })).toEqual([])
  })

  it('%context on a datatype input is the same raw value, so it flags too', () => {
    expect(codes('%context.CodeableConcept.text', datatype)).toEqual(['datatype-root'])
  })
})

describe('type narrowing (ofType/as)', () => {
  it('ofType() narrows to the named type so checks resume', () => {
    expect(codes('Patient.deceased.ofType(boolean).not()')).toEqual([])
    expect(codes('Patient.deceased.ofType(dateTime).yearOf()')).toEqual([])
    expect(codes('Patient.deceased.ofType(boolean).nope')).toEqual(['unknown-element'])
  })

  it('narrowing an unknown region resumes checking without claiming a cardinality', () => {
    expect(codes('Patient.children().ofType(HumanName).nope')).toEqual(['unknown-element'])
    // Cardinality after children() is unknown, so no singleton diagnostic either way.
    expect(codes('Patient.children().ofType(HumanName).use.single().length()')).toEqual([])
  })

  it('the as operator and function intersect with the known candidates', () => {
    expect(codes('(Patient.deceased as dateTime).yearOf()')).toEqual([])
    expect(codes('Patient.deceased.as(dateTime).yearOf()')).toEqual([])
    expect(codes('(Patient.deceased as dateTime).nope')).toEqual(['unknown-element'])
  })

  it('an impossible narrowing warns that the result is always empty', () => {
    const diagnostics = analyzeExpression('Patient.name.first().ofType(Quantity)', options)
    expect(diagnostics.map(d => [d.severity, d.code])).toEqual([['warning', 'always-empty']])
    expect(codes('(Patient.birthDate as Quantity)')).toEqual(['always-empty'])
  })
})

describe('lambda result typing', () => {
  it('select() returns the projection type', () => {
    expect(codes('Patient.name.select(given.first()).substring(1)')).toEqual(['singleton-required'])
    expect(codes('Patient.name.first().select(family).substring(1)')).toEqual([])
    expect(codes('Patient.name.select(nope)')).toEqual(['unknown-element'])
  })

  it('iif() returns the union of its branch types', () => {
    expect(codes("iif(Patient.active, 'yes', 'no').length()")).toEqual([])
    expect(codes("iif(Patient.active, 'yes', 'no') + 1")).toEqual(['operand-type'])
    // Mixed-kind branches mute kind checks, exactly like a mixed union.
    expect(codes("iif(Patient.active, 1, 'no') + 1")).toEqual([])
    // A missing else-branch contributes empty, which any operand accepts.
    expect(codes('iif(Patient.active, 1) + 1')).toEqual([])
  })

  it('iif() checks its criterion for cardinality and Boolean-ness', () => {
    expect(codes('iif(Patient.name.given, 1, 2)')).toEqual(['singleton-required'])
    expect(codes("iif('nope', 1, 2)")).toEqual(['operand-type'])
    expect(codes('iif({} | true, 1, 2)')).toEqual([])
  })

  it('coalesce() returns the union of its arguments', () => {
    expect(codes("coalesce(Patient.name.family.first(), 'unknown').length()")).toEqual([])
  })

  it('aggregate() returns the aggregator result or its initializer for empty input', () => {
    expect(codes('Patient.name.aggregate($this.given.first()).length()')).toEqual([])
    expect(codes('Patient.name.aggregate($this.given.first()) + 1')).toEqual(['operand-type'])
    expect(codes('Patient.name.aggregate($this.given.first(), 0) + 1')).toEqual([])
    expect(analyzeExpressionDetailed('Patient.name.aggregate($this.given.first(), 0)', options).result).toEqual({
      types: ['FHIR.string', 'System.Integer'],
      single: true,
    })
  })

  it('sort() keys accept a top-level descending minus on any type', () => {
    expect(codes('Patient.name.sort(-family, given.first()).first().use')).toEqual([])
    expect(codes('Patient.name.sort(-nope)')).toEqual(['unknown-element'])
  })
})

describe('variable tracking', () => {
  it('flags undefined environment variables like the runtime does', () => {
    expect(codes('%nope.value')).toEqual(['unknown-variable'])
  })

  it('resolves built-in variables with their types', () => {
    expect(codes('%resource.name.given')).toEqual([])
    expect(codes('%resource.nope')).toEqual(['unknown-element'])
    expect(codes("%ucum = 'http://unitsofmeasure.org' and %sct.length() > 0 and %loinc.exists()")).toEqual([])
    expect(codes('%`vs-administrative-gender`.length() > 0')).toEqual([])
    expect(codes('%`ext-patient-birthTime`.length() > 0')).toEqual([])
  })

  it('defineVariable() bindings carry the analyzed state of their value', () => {
    expect(codes("Patient.name.first().defineVariable('n').select(%n.family.substring(1))")).toEqual([])
    expect(codes("defineVariable('given', Patient.name.first().given).select(%given.substring(1))")).toEqual([
      'singleton-required',
    ])
    expect(codes("defineVariable('x', name.first()).select(%x.nope)")).toEqual(['unknown-element'])
  })

  it('flags redefinition and overriding environment variables', () => {
    expect(codes("defineVariable('v').defineVariable('v')")).toEqual(['variable-redefined'])
    expect(codes("defineVariable('context', 'oops')")).toEqual(['variable-override'])
  })

  it('scopes variables to their chain, like the runtime', () => {
    // A variable defined in one union operand is not visible in the other.
    expect(codes("(defineVariable('n1').active | %n1)")).toEqual(['unknown-variable'])
    // A variable defined inside a function argument does not leak out.
    expect(codes("select(defineVariable('inner').active).where(%inner)")).toEqual(['unknown-variable'])
    // Dynamic names cannot be tracked: nothing is registered, and undefined-variable
    // errors are muted for the rest of that chain (the dynamic name may have bound one).
    expect(codes('defineVariable(name.family.first()).count() > 0')).toEqual([])
    expect(codes('defineVariable(name.family.first()).select(%whatever)')).toEqual([])
    // The muting is scoped: a sibling operand still gets the error.
    expect(codes('defineVariable(name.family.first()).active | %whatever')).toEqual(['unknown-variable'])
  })
})

describe('warnings and details', () => {
  it('a collection passed where a singleton argument is expected is a warning', () => {
    const diagnostics = analyzeExpression('Patient.name.first().family.startsWith(Patient.name.given)', options)
    expect(diagnostics.map(d => [d.severity, d.code])).toEqual([['warning', 'argument-singleton']])
  })

  it('quantity arithmetic yields quantities', () => {
    expect(codes("(4.0 'g' / 2.0 'm') = 2 'g/m'")).toEqual([])
    expect(codes("(2 'mg' * 3) = 6 'mg'")).toEqual([])
    expect(codes('(4.0 / 2.0) = 2.0')).toEqual([])
  })

  it('reports the element paths an expression touches', () => {
    const { elementDependencies } = analyzeExpressionDetailed('Patient.name.where(use = %v1).given.first()', {
      model: r4Model,
      inputType: 'Patient',
    })
    expect(elementDependencies).toEqual(['Patient.name', 'HumanName.use', 'HumanName.given'])
  })

  it('System.Quantity components are not model-element dependencies', () => {
    expect(analyzeExpressionDetailed("(1 'kg').value + 1", options).elementDependencies).toEqual([])
  })

  it('detailed analysis carries the diagnostics too', () => {
    const details = analyzeExpressionDetailed('Patient.nope', options)
    expect(details.diagnostics.map(d => d.code)).toEqual(['unknown-element'])
    expect(analyzeExpressionDetailed('1 +').diagnostics.map(d => d.code)).toEqual(['syntax'])
    expect(analyzeExpressionDetailed('1 +').elementDependencies).toEqual([])
  })
})

describe('resolve() reference-target typing', () => {
  it('yields the declared target types, so checks resume past resolve()', () => {
    // Patient.generalPractitioner targets Organization | Practitioner | PractitionerRole.
    expect(codes('Patient.generalPractitioner.resolve().name')).toEqual([])
    expect(codes('Patient.generalPractitioner.resolve().nope')).toEqual(['unknown-element'])
    // Observation.subject is single, so the resolved resource is too.
    expect(
      codes('Observation.subject.resolve().id.length() > 0', { model: r4Model, inputType: 'Observation' })
    ).toEqual([])
  })

  it('targets survive the state algebra: selection, filters, projections, unions, indexing', () => {
    expect(codes('Patient.generalPractitioner.first().resolve().nope')).toEqual(['unknown-element'])
    expect(codes('Patient.generalPractitioner[0].resolve().nope')).toEqual(['unknown-element'])
    expect(codes('Patient.generalPractitioner.where(reference.exists()).resolve().nope')).toEqual(['unknown-element'])
    expect(codes('Patient.generalPractitioner.select($this).resolve().nope')).toEqual(['unknown-element'])
    expect(codes('(Patient.generalPractitioner | Patient.managingOrganization).resolve().nope')).toEqual([
      'unknown-element',
    ])
    expect(codes('Patient.generalPractitioner.union(Patient.managingOrganization).resolve().nope')).toEqual([
      'unknown-element',
    ])
    expect(codes('iif(true, Patient.generalPractitioner, Patient.managingOrganization).resolve().nope')).toEqual([
      'unknown-element',
    ])
    // A union with a non-reference side has no common target set: muted, not wrong.
    expect(codes('(Patient.generalPractitioner | Patient.name).resolve().anything')).toEqual([])
  })

  it('an unconstrained or non-reference input stays an unknown region', () => {
    // Reference.reference is a plain string; resolve() on strings is unconstrained.
    expect(codes('Patient.generalPractitioner.reference.resolve().anything')).toEqual([])
    // Bundle.entry.resource is any resource: no targets, still muted.
    expect(codes('Bundle.entry.resource.resolve().anything', { model: r4Model, inputType: 'Bundle' })).toEqual([])
  })
})

describe('analyzeSite', () => {
  const options = { model: r4Model }

  it('analyzes an ordinary site as written', () => {
    expect(analyzeSite({ expression: 'Patient.namee' }, options).map(d => d.code)).toEqual(['unknown-element'])
    expect(analyzeSite({ expression: 'Patient.name' }, options)).toEqual([])
  })

  it('analyzes an ordinary site against the root it declares', () => {
    // fhirpath("…", 'MedicationRequest'): a relative expression becomes checkable.
    const rooted = { expression: "(statuss in ('draft')).not()", inputType: 'MedicationRequest' }
    expect(analyzeSite(rooted, options).map(d => d.code)).toEqual(['unknown-element'])
    expect(analyzeSite({ ...rooted, expression: "(status in ('draft')).not()" }, options)).toEqual([])
    // Declaring where an expression runs says nothing about the data bound to it,
    // so engine env is left alone.
    expect(
      analyzeSite({ expression: 'code.coding.exists(system = %loinc)', inputType: 'Observation' }, options)
    ).toEqual([])
    // Without the root, the same expression is muted rather than mis-checked.
    expect(analyzeSite({ expression: "(statuss in ('draft')).not()" }, options)).toEqual([])
  })

  it('analyzes a DTO column against its fhirType', () => {
    expect(
      analyzeSite({ expression: 'clinicalStatus.coding.first().code', inputType: 'Condition', dto: true }, options)
    ).toEqual([])
    expect(
      analyzeSite({ expression: 'clinicalStatus.codingg.first()', inputType: 'Condition', dto: true }, options).map(
        d => d.code
      )
    ).toEqual(['unknown-element'])
  })

  it('leaves a DTO column vars and functions unjudged', () => {
    // %badge is declared by the DTO, a base class, or the projecting call, and
    // displayText() by whichever DTO the engine registers — neither is visible here.
    expect(analyzeSite({ expression: '%badge.label', inputType: 'DiagnosticReport', dto: true }, options)).toEqual([])
    expect(analyzeSite({ expression: 'code.displayText()', inputType: 'Condition', dto: true }, options)).toEqual([])
    // The same expressions outside a DTO site keep their findings.
    expect(analyzeSite({ expression: '%badge.label' }, options).map(d => d.code)).toEqual(['unknown-variable'])
  })

  it('resolves calls into the columns the site file declares', () => {
    const functions = {
      displayText: { minArity: 0, maxArity: 0, signature: { result: { types: ['string'], single: true } } },
    }
    const site = { inputType: 'Observation', dto: true as const, functions }
    // The call resolves, and its declared result type carries downstream.
    expect(analyzeSite({ ...site, expression: 'code.displayText()' }, options)).toEqual([])
    expect(analyzeSite({ ...site, expression: 'code.displayText().length()' }, options)).toEqual([])
    expect(analyzeSite({ ...site, expression: 'code.displayText() + 1' }, options).map(d => d.code)).toEqual([
      'operand-type',
    ])
    // A near-miss of a declared column is a typo worth reporting…
    expect(analyzeSite({ ...site, expression: 'code.displayTxt()' }, options).map(d => d.message)).toEqual([
      "Unrecognized function 'displayTxt' — did you mean 'displayText'?",
    ])
    // …while an unrelated unresolved name is most likely a DTO in another module.
    expect(analyzeSite({ ...site, expression: 'code.reportBadge()' }, options)).toEqual([])
    // An ordinary site sees the file's columns too, so a valid call is not a finding.
    expect(analyzeSite({ expression: 'Observation.code.displayText()', functions }, options)).toEqual([])
  })

  it('reports only syntax findings for a DTO column with no known root', () => {
    // A leading `code`/`text` segment is also a model type name, so without a
    // root the analyzer would read it as a type-name root and report nonsense.
    expect(analyzeSite({ expression: 'code.coding.first().display', dto: true }, options)).toEqual([])
    expect(analyzeSite({ expression: 'code.text', dto: true }, options)).toEqual([])
    expect(analyzeSite({ expression: 'code.text(', dto: true }, options).map(d => d.code)).toEqual(['syntax'])
    // Unguarded, that first expression is a false positive.
    expect(analyzeSite({ expression: 'code.coding.first().display' }, options).map(d => d.code)).toEqual([
      'unknown-element',
    ])
  })
})
