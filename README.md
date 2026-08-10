# fhirpath-ts

A TypeScript-native [FHIRPath](https://hl7.org/fhirpath/) engine for application
development. It has zero runtime dependencies and includes:

- typed results for literal expressions in plain TypeScript;
- an R4 model and application helpers for common FHIRPath jobs;
- DTOs that turn FHIR resources into checked application data;
- static checks through TypeScript, ESLint, a CLI, and a public analyzer API;
- exact decimal arithmetic, partial-precision dates and times, and UCUM conversions;
- official HL7 conformance tests plus tests from other FHIRPath engines.

## Why use it

### Application development

FHIRPath is most useful in an application when it has a small, clear job. This
package gives those jobs direct APIs:

| Job | API | Result |
| --- | --- | --- |
| Read a collection | `evaluate()` | `T[]` |
| Read one optional value | `first()` | `T \| undefined` |
| Apply criteria | `test()` | `boolean` |
| Filter resources | `filter()` | resources of the same type |
| Check FHIR constraints | `checkConstraints()` | issues and an `OperationOutcome` |
| Build application rows | `project()` with a DTO | typed class instances |

The R4 entry point binds the model once:

```ts
import { r4 } from 'fhirpath-ts/r4'
```

Choice elements work by stem name, such as `Observation.value`. Primitive
extensions, FHIR type checks, Bundle traversal, and contained or bundled
references use the same model.

### Developer experience

Literal expressions infer useful result and input types without a compiler
plugin:

```ts
const given = r4.compile('Patient.name.given')
given.evaluate(patient) // string[]; the input must be a Patient
```

Type inference stays conservative. Expressions outside its supported subset
become `unknown[]` instead of producing an incorrect type.

The analyzer checks the rules in FHIRPath specification §11. It reports unknown
elements and functions, wrong argument or operand types, invalid cardinality,
and other errors before the expression runs. Use it through the ESLint rule,
the `fhirpath-check` CLI, or `fhirpath-ts/analyzer`. See
[Static checking](docs/static-checking.md) for setup and exact limits.

Other development features include:

- compile once and reuse, or rely on each engine's LRU parse cache;
- fixed clocks and explicit `trace()` sinks for repeatable tests;
- custom functions described once for evaluation and static checking;
- source positions in parser and analyzer errors;
- no runtime dependencies and no generated parser step.

## Quick start

```ts
import { r4 } from 'fhirpath-ts/r4'

const patient = {
  resourceType: 'Patient',
  active: true,
  name: [{ family: 'Okoro', given: ['Adaeze', 'Mina'] }],
} as const

r4.evaluate('Patient.name.given', patient) // ['Adaeze', 'Mina']
r4.first('Patient.name.family', patient) // 'Okoro'
r4.test(patient, 'Patient.active = true') // true

const family = r4.compile('Patient.name.family')
family.evaluate(patient) // ['Okoro']
```

Engine methods parse on demand and cache by expression text. Build a separate
engine when you need different defaults:

```ts
import { FhirPathEngine } from 'fhirpath-ts'
import { r4Model } from 'fhirpath-ts/r4'

const fp = new FhirPathEngine({ model: r4Model, env: { threshold: 5 } })
fp.evaluate('%threshold + 1') // [6]
```

See [API reference](docs/api.md) for all entry points, options, custom functions,
DTO behavior, parse caching, and Medplum type compatibility.

## Suggested usage: DTOs

For application code, prefer a DTO when several expressions build one row or
view model. The resource type is declared once. Each field keeps its TypeScript
type, and getters or methods can handle work that is clearer in TypeScript.

```ts
import { column, criteria, defineDto } from 'fhirpath-ts'
import { r4 } from 'fhirpath-ts/r4'

class PatientRow extends defineDto('Patient') {
  @column('id', { default: '' })
  id!: string

  @column("name.where(use = 'official').first().family", { default: '' })
  family!: string

  @criteria('active = true')
  active!: boolean

  get label(): string {
    return this.family || this.id
  }
}

const rows = r4.project([patient], PatientRow)
rows[0] // PatientRow { id: '', family: '', active: true }
rows[0]?.label // ''
```

`@column` and `@criteria` use standard JavaScript decorators. Your build must
lower them. TypeScript works with `target` set to ES2024 or lower. SWC and Babel
also support them. For a build without decorator support, pass a plain column
record to `project()`.

DTOs can also register their columns as FHIRPath functions. This is useful for
shared application vocabulary such as `displayText()` or `isFinal()`. Read the
[DTO reference](docs/api.md#dtos) before registering DTOs because function names,
input types, local environment values, inheritance, and dispatch have important
rules.

## Usage recipes

These short examples show the main application APIs. The
[playground](demo/README.md) is the best place to explore expressions
interactively. A test runs every static expression in this section and checks it
with the analyzer.

### Read, test, and filter

```ts
r4.evaluate('Patient.name.given', patient)
r4.first('Patient.name.family', patient)
r4.test(patient, 'birthDate <= today()', { now: new Date('2026-08-04T12:00:00Z') })

const systolic = r4.filter(
  observations,
  "Observation.code.coding.exists(system = %loinc and code = '8480-6')",
  { env: { loinc: 'http://loinc.org' } },
)
const newestFirst = r4.evaluate(
  'Observation.sort(-(effective.ofType(dateTime) | issued).first())',
  systolic,
)
```

### Check constraints

`checkConstraints()` evaluates constraint expressions. It does not perform full
profile validation such as cardinality, bindings, or slicing.

```ts
const result = r4.checkConstraints(patient, [
  {
    key: 'pat-1',
    severity: 'error',
    human: 'Contact needs a name or telecom',
    expression: 'contact.all(name.exists() or telecom.exists())',
  },
])

result.valid
result.issues
result.toOperationOutcome()
```

### Project a DTO

```ts
class MedicationRow extends defineDto('MedicationRequest') {
  @column('id', { default: '' })
  id!: string

  @column(
    '(medication.ofType(CodeableConcept).select(text | coding.display.first()) | medication.ofType(Reference).display).first()',
    { default: 'Medication' },
  )
  name!: string

  @criteria("status = 'active'")
  active!: boolean
}

const medicationRows = r4.project(requests, MedicationRow)
```

DTO fields are scalar by default. More than one result is an error. Use
`first()` in the expression or `{ collection: true }` for an array field.

### Display text with fallbacks

A union tries alternatives in order. `first()` chooses the first value:

```ts
r4.first(
  'Condition.code.select(text | coding.display.first() | coding.first().code).first()',
  condition,
  { type: 'string' },
)

r4.first(
  "(Patient.name.where(use = 'official') | Patient.name).first().select(iif(given.exists(), given.first().combine(family).join(' '), (text | family).first()))",
  patient,
  { type: 'string' },
)
```

### Convert quantities

Known UCUM units compare and convert automatically. Unknown units can still
compare with the same unit.

```ts
r4.filter(observations, "value.ofType(Quantity) > 140 'mm[Hg]'")
r4.filter(observations, "value.ofType(Quantity).convertsToQuantity('kg')")
r4.first("Observation.value.ofType(Quantity).toQuantity('kg').value", weight)
```

### Map status labels

`choices` converts codes into typed application values. A missing code becomes
empty, so `default` also handles future or unexpected codes.

```ts
const STATUS_CHOICES = [
  { code: 'active', label: 'Active', tone: 'info' },
  { code: 'recurrence', label: 'Recurrence', tone: 'danger' },
  { code: 'resolved', label: 'Resolved', tone: 'neutral' },
] as const

r4.project(conditions, {
  label: {
    path: 'Condition.clinicalStatus.coding.first().code',
    choices: STATUS_CHOICES,
    pick: 'label',
    default: 'Unknown',
  },
  tone: {
    path: 'Condition.clinicalStatus.coding.first().code',
    choices: STATUS_CHOICES,
    pick: 'tone',
    default: 'neutral' as const,
  },
})
```

### Join related resources

Pass lookup data through `env`. Use `vars` to find the related item once per
row. `%context` is the resource for the current row.

```ts
const reports = [...reportsByOrderId].map(([orderId, report]) => ({ orderId, report }))

r4.project(
  orders,
  {
    resultDate: {
      path: '(%report.effective.ofType(dateTime) | %report.issued).first()',
      type: 'string',
      default: null,
    },
    hasResult: { test: '%report.exists()' },
  },
  { env: { reports }, vars: { report: '%reports.where(orderId = %context.id).report' } },
)
```

### Follow references in a Bundle

`resolve()` follows contained references and references to another Bundle entry.
Start at `Bundle` so the Bundle remains available as the lookup scope.

```ts
r4.evaluate(
  'Bundle.entry.resource.ofType(Observation).subject.resolve().name.family',
  searchset,
)
```

### Walk nested structures

```ts
r4.evaluate('Questionnaire.repeat(item).linkId', questionnaire)
```

### Deterministic tests and debugging

`now` fixes the evaluation clock. `trace()` sends values to the sink you provide
and does not log by itself.

```ts
r4.test(patient, 'birthDate <= today()', {
  now: new Date('2026-08-04T12:00:00Z'),
})

r4.evaluate("Patient.name.trace('names').given", patient, {
  trace: (name, values) => debugSink(name, values),
})
```

## Important details

- FHIRPath always evaluates collections. Use `first()` when application code
  expects one optional value.
- Unknown elements evaluate to an empty collection, as they do in the reference
  engines. Use static checking to catch misspellings before runtime.
- Use choice stems such as `Observation.value`, not JSON keys such as
  `valueQuantity`. The analyzer reports the latter as an error.
- A bare search Bundle is treated as its entry resources for application helpers.
  Start an expression at `Bundle` to address the Bundle itself, or wrap it in an
  array to force one-resource treatment.
- Inside `where()`, the focus is the item being scanned. Use `%context` or a
  `%var` when a join condition needs the outer resource.
- `env` contains plain host values. `vars` contains FHIRPath expressions evaluated
  against the input and keeps FHIRPath type information.
- `project()` creates view data. It is not a replacement for StructureMap or the
  FHIR Mapping Language.
- The engine is synchronous. External reference resolution and terminology calls
  need the deferred async API described below.

## Static checking

Static checking has three layers:

1. TypeScript infers common literal expressions at compile time.
2. `fhirpath-ts/eslint` checks expression literals while linting.
3. `fhirpath-check` runs the same analyzer without requiring ESLint and can load
   exported DTOs for a complete DTO check.

The analyzer is also public for editors, tests, and other tools. It follows the
FHIRPath §11 rules and is tested against the official valid and invalid cases.
See [Static checking](docs/static-checking.md) for configuration, supported call
sites, DTO discovery, and cases where source-only checks stay quiet.

## Conformance

The engine passes every non-skipped case in the vendored official R4 and R5
FHIRPath suites. It also runs the fhirpath.js and fhirpath-py corpora. Each skip
and intentional difference has a checked manifest entry with its reason.

Property tests cover parser round trips, decimal arithmetic, and temporal
comparisons. Generated expressions are also compared with fhirpath.js. A weekly
job checks for changes in the upstream official suite.

See [Conformance](docs/conformance.md) for counts, skip categories, phase checks,
reference-suite results, and test maintenance. See
[Engine comparison](docs/engine-comparison.md) for the feature and correctness
comparison with other implementations.

## Licensing and attribution

Package code is part of this private repository. Third-party material and full
license texts are collected in
[`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md). Include that file in any
future npm package or open-source distribution.

- The parser structure is adapted from Medplum (Apache-2.0).
- Official FHIRPath tests come from FHIR/fhir-test-cases (Apache-2.0 and FHIR CC0
  content).
- Reference tests come from HL7/fhirpath.js (NLM BSD-style) and fhirpath-py (MIT).
- Additional cases come from fhirpath-rs (Apache-2.0) and Medplum.
- R4 model data is generated from HL7 FHIR R4 StructureDefinitions (CC0) in
  `@medplum/definitions`. FHIR® is a registered trademark of HL7.

## Development

```bash
pnpm test
pnpm coverage
pnpm typecheck
pnpm lint
pnpm check:fhirpath
pnpm check:type-perf
pnpm generate:r4
```

Run the demo separately:

```bash
cd demo
npm install
npm run dev
```

After changing the public API, run `npm run generate:dts` in `demo/` to refresh
the Monaco declarations. See [AGENTS.md](AGENTS.md) for repository decisions that
are easy to break during maintenance.

## Gaps and deferred features

The package currently ships only an R4 model. The engine is synchronous. Tagged
templates remain untyped because TypeScript does not preserve their literal type
([TypeScript #33304](https://github.com/microsoft/TypeScript/issues/33304)); use
`fhirpath('...')` or `compile('...')` for inference. Regex evaluation of
user-authored expressions needs the security setup below.

These features are deferred and fail with a clear error today:

| Feature | What it needs |
| --- | --- |
| `memberOf()`, `subsumes()`, `subsumedBy()`, `%terminologies` | An async `TerminologyProvider` |
| External `resolve()` | The same async evaluation path |
| `conformsTo()` beyond base StructureDefinitions | Profile-aware validation |
| `slice()`, `elementDefinition()`, `checkModifiers()` | Profile definitions in the model |
| `weight()` | Code-system `itemWeight` lookups |
| `%factory` | Demand for the current R5 draft API |
| CDA mode | A CDA `ModelProvider` |
| Full UCUM | A full UCUM implementation behind the current interface |
| R5 model package | Generated R5 definitions and types |

## Security

### Expression trust

Parser depth, tokenization, decimal and UCUM exponents, and property navigation
have limits suitable for untrusted input. Regular expressions need one extra
step. By default, `matches()`, `matchesFull()`, and `replaceMatches()` use the
host `RegExp`, so a pattern with catastrophic backtracking can block the event
loop.

The analyzer warns about backtracking-prone literal patterns. If users can write
expressions, also provide a linear-time regular expression engine, such as an RE2
binding, through `EvaluateOptions.regex`. Review or sandbox user expressions as
appropriate for the application.

### Narrative checking

`htmlChecks()` checks FHIR narrative rules and allows only inert URL schemes. It
decodes attribute entities in the same way as a browser. A `true` result means
the narrative contains no active content.

### PHI and tracing

`trace()` does nothing unless a trace sink is provided. Traced values may contain
patient data. Never send PHI values to console output or production logs; use
record identifiers instead.
