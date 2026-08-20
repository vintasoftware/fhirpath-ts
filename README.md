# fhirpath-ts

A TypeScript-native [FHIRPath](https://hl7.org/fhirpath/) engine for application
development. It has zero runtime dependencies and includes:

- typed results for literal expressions in plain TypeScript;
- DTOs that transform FHIR resources into typed application data;
- static checks through TypeScript, ESLint, a CLI linter/analyzer, and a public analyzer API;
- official HL7 conformance tests plus tests from other FHIRPath engines;
- [Medplum](https://www.medplum.com/) compatibility;
- currently focused in FHIR R4, the most commonly used FHIR version.

Check the [playground demo](https://vintasoftware.github.io/fhirpath-ts/) or keep reading!

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

const fp = new FhirPathEngine({
  model: r4Model,
  env: { threshold: 5 },
})
fp.evaluate('%threshold + 1') // number[]; [6]
```

```ts-invalid
const strict = new FhirPathEngine({ model: r4Model, strict: true })
strict.evaluate('Patient.name.givenn', patient) // throws FhirPathTypeError
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

  @column('name.given', { collection: true })
  givenNames!: string[]

  @criteria('active = true')
  active!: boolean

  get label(): string {
    return this.family || this.id
  }
}

const rows = r4.project([patient], PatientRow)
rows[0] // PatientRow { id: '', family: '', givenNames: [], active: true }
rows[0]?.label // ''
```

`@column` and `@criteria` use standard JavaScript decorators. Your build must
transpile them. TypeScript works with `target` set to ES2024 or lower. SWC and Babel
also support them. For a build without decorator support,
[use records with `project()`](docs/api.md#project).

Pass DTOs through `resourceDtos` to call their columns from expressions with other
FHIR resources as root:

```ts
class CodeableConceptDto extends defineDto('CodeableConcept') {
  @column('(text | coding.display.first() | coding.first().code).first()')
  displayText!: string | undefined
}

const fp = new FhirPathEngine({
  model: r4Model,
  resourceDtos: [CodeableConceptDto],
})

fp.first('Condition.code.displayText()', condition)
```

This is useful for shared application vocabulary such as `displayText()` or `isFinal()`.

Name DTO modules `*.dto.ts` and export the classes: `fhirpath-check` imports
modules matching `**/*.dto.ts` by default and checks each DTO against its
engine. See [DTO discovery](docs/static-checking.md#dto-discovery).

## Usage recipes

These short examples show the main application APIs. The
[playground demo](https://vintasoftware.github.io/fhirpath-ts/) is the best place to explore expressions
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

result.valid // true
result.issues // []
result.toOperationOutcome() // { resourceType: 'OperationOutcome', issue: [{ severity: 'information', ... }] }
```

### Convert quantities

Known [UCUM](https://ucum.org/ucum) units compare and convert automatically.
Unknown units can still compare with the same unit.

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

const statusRows = r4.project(conditions, {
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

statusRows // [{ label: 'Active', tone: 'info' }, ..., { label: 'Unknown', tone: 'neutral' }]
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
      default: null,
    },
    hasResult: { test: '%report.exists()' },
  },
  {
    env: { reports },
    vars: { report: '%reports.where(orderId = %context.id).report' },
    varTypes: { report: { type: 'DiagnosticReport' } },
  },
)
```

The wrapper objects in `%reports` are plain lookup data with no FHIR type, so
`fhirpath-check` cannot verify the `where(orderId = ...)` lookup. It reports
that line as an `unchecked-navigation` warning, which `--strict` turns into an
error. The `varTypes` declaration is what lets the column paths be checked.
When `env` holds FHIR resources directly, declare their types with `envTypes`
and every path is checked. See [Static checking](docs/static-checking.md).

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

`repeat(item)` follows every nested `item` collection and returns the items at
all depths, so this reads each questionnaire item's `linkId`.

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

## Important gotchas

- FHIRPath always evaluates collections. Use `first()` when application code
  expects one optional value.
- Unknown elements evaluate to an empty collection, as they do in other
  engines. Use [static checking](#static-checking), or set `strict: true` on an
  engine or evaluation call, to catch misspellings before data is read.
- Use choice stems such as `Observation.value`, not JSON keys such as
  `valueQuantity`. The analyzer and strict evaluation report the latter as an
  error; lenient evaluation returns an empty collection.
- Function names and arguments are strict: an unknown function, wrong arity or
  type, or undefined `%variable` is an error. See the
  [runtime error table](docs/api.md#what-throws-errors-and-what-doesnt).
- A bare search Bundle is treated as its entry resources for application helpers.
  Start an expression at `Bundle` to address the Bundle itself, or wrap it in an
  array to force one-resource treatment.
- Inside `where()`, the focus is the item being scanned. Use `%context` or a
  `%var` when a join condition needs the outer resource.
- `env` contains plain host values. `vars` contains FHIRPath expressions evaluated
  against the input and keeps FHIRPath type information.

## Static checking

Literal expressions use a bounded type-level parser that follows the runtime
grammar and built-in function rules. It infers result and input types without a
compiler plugin:

```ts
const given = r4.compile('Patient.name.given')
given.evaluate(patient) // string[]; the input must be a Patient
```

Type inference stays conservative. Malformed, over-budget, dynamically widened,
or deliberately opaque expressions become `unknown[]` instead of producing an
incorrect type. Literal host values are inferred automatically. Static
`envTypes` and `varTypes` declarations cover ambiguous or widened data; see
[type context declarations](docs/api.md#type-context-declarations).
The type-level scanner budget is 64 tokens and 256 visited source characters.
Type inference computes a safe TypeScript type; it does not validate the
expression. ESLint and the CLI run the analyzer to report expression errors.

Static checking has three layers:

1. TypeScript infers literal expressions at compile time.
2. `fhirpath-ts/eslint` checks expression literals while linting.
3. `fhirpath-check` runs the same analyzer without requiring ESLint and can load
   exported DTOs for a complete DTO check.

The CLI imports exported DTOs and records engines constructed by their modules.
This checks runtime context, registered functions, and cross-DTO calls that
TypeScript and source-only ESLint cannot see.

The analyzer is also public for editors, tests, and other tools. It follows the
[FHIRPath §11 rules](https://hl7.org/fhirpath/en/index.html#type-safety-and-strict-evaluation)
and is tested against the official valid and invalid cases.
See [Static checking](docs/static-checking.md) for configuration, supported call
sites, DTO discovery, and cases where source-only checks stay quiet.

## Conformance

The engine passes every non-skipped case in the vendored official R4 and R5
FHIRPath suites. It also runs the fhirpath.js and fhirpath-py corpora. Each skip
and intentional difference has a checked manifest entry with its reason.

Property tests cover parser round trips, decimal arithmetic, and temporal
comparisons. Generated expressions are also compared with fhirpath.js. A weekly
job checks for changes in the upstream official suite (FHIR/fhir-test-cases).

See [Conformance](docs/conformance.md) for counts, skip categories, phase checks,
reference-suite results, and test maintenance. See
[Engine comparison](docs/engine-comparison.md) for the feature and correctness
comparison with other implementations.

## Licensing and attribution

Package code is licensed under Apache-2.0. Third-party material and full license
texts are collected in
[`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md).

- The parser structure is adapted from Medplum (Apache-2.0).
- Official FHIRPath tests come from FHIR/fhir-test-cases (Apache-2.0 and FHIR CC0
  content).
- Reference tests come from HL7/fhirpath.js (NLM BSD-style) and fhirpath-py (MIT).
- Additional cases come from fhirpath-rs (Apache-2.0) and Medplum.
- R4 model data is generated from HL7 FHIR R4 StructureDefinitions (CC0) in
  `@medplum/definitions`. FHIR® is a registered trademark of HL7.

## Development

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm check:fhirpath
pnpm check:inference
pnpm check:type-perf
pnpm coverage
pnpm build
pnpm check:package
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
`fhirpath('...')` or `compile('...')` for inference in strings.
Regex evaluation of user-authored expressions needs the security setup below.

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

## Security guidelines

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
