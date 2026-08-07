# API reference

This guide covers the main runtime API, options, custom functions, DTOs, and
common behavior that affects application code.

## Entry points

| Import | Purpose |
| --- | --- |
| `fhirpath-ts/r4` | R4 engine, model, and generated R4 types |
| `fhirpath-ts` | Engine class, stateless functions, compiler, DTO helpers, and shared types |
| `fhirpath-ts/analyzer` | Static analyzer APIs |
| `fhirpath-ts/eslint` | ESLint plugin |
| `fhirpath-ts/sites` | TypeScript AST expression-site finder |

Use the bound R4 engine for most application code:

```ts
import { r4 } from 'fhirpath-ts/r4'

r4.evaluate('Patient.name.given', patient)
r4.first('Patient.name.family', patient)
```

Create an engine when the application needs its own defaults:

```ts
import { FhirPathEngine } from 'fhirpath-ts'
import { r4Model } from 'fhirpath-ts/r4'

const fp = new FhirPathEngine({
  model: r4Model,
  env: { system: 'http://loinc.org' },
})
```

## Engine methods

### `evaluate()`

Evaluates an expression and returns every result as plain JavaScript values.
Literal expressions infer their result and input types.

```ts
r4.evaluate('Patient.name.given', patient) // string[]
```

### `first()`

Returns the first result, or `undefined` for an empty collection.

```ts
r4.first('Patient.name.family', patient) // string | undefined
```

Use this when application code expects one optional value. Use `single()` in the
FHIRPath expression when more than one value should be an error.

### `test()`

Applies the boolean rules used by FHIR criteria. One boolean returns itself. An
empty result is `false`. More than one value is an error.

```ts
r4.test(patient, 'active = true') // boolean
```

### `filter()`

Keeps resources for which `test()` returns `true`. It accepts resource arrays and
Bundles.

```ts
r4.filter(patients, 'birthDate < @1990-01-01') // Patient[]
```

### `checkConstraints()`

Checks expressions shaped like `ElementDefinition.constraint` values:

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

`valid` is `false` only when an error-severity constraint fails. Issues retain
the constraint data. `toOperationOutcome()` creates a FHIR report with
`issue.code = 'invariant'`.

This method checks constraint expressions. It does not validate profile
cardinality, terminology bindings, slicing, or the rest of a StructureDefinition.

Arrays and Bundles are checked one resource at a time. Issues include the input
index. Bundle issues point to `Bundle.entry[i].resource`. Wrap a Bundle in an
array to check the Bundle itself.

### `project()`

Projects each input resource into either a plain object or a DTO instance. Plain
column records support these shapes:

```ts
const rows = r4.project(patients, {
  id: 'Patient.id',
  family: 'Patient.name.family.first()',
  given: { path: 'Patient.name.given', collection: true },
  born: { path: 'Patient.birthDate', as: 'Date' },
  gender: { path: 'Patient.gender', default: 'unknown' },
  active: { test: 'Patient.active = true' },
})
```

A scalar column must return zero or one value. More than one value is an error.
Set `collection: true` for an array. Other options are:

| Option | Meaning |
| --- | --- |
| `path` | FHIRPath expression for a value column |
| `test` | FHIRPath expression with `test()` semantics |
| `type` | Compile-time result declaration when inference cannot read the expression |
| `as` | Convert each value to a named JavaScript type or with a function |
| `default` | Value used for an empty result; also removes `undefined` from the type |
| `enum` | Allowed literal values; a different value becomes empty |
| `choices` | Code-to-value table or record |
| `pick` | Field to return from a `choices` table row |
| `collection` | Return all results instead of one scalar |

`type` is a TypeScript declaration. The runtime does not validate it. Use the
analyzer or a DTO check when an expression falls outside TypeScript's inference
subset.

Each row evaluates with `%rowIndex` and `%rowTotal`. Indexes are zero-based. A
single resource gets index `0` and total `1`.

`project()` creates application data. Structure-to-structure transformation is
the job of StructureMap and the FHIR Mapping Language.

### `compile()`

Parses once and returns a reusable expression:

```ts
const given = r4.compile('Patient.name.given')
given.evaluate(patient)
```

An optional second argument declares the input type for a relative expression:

```ts
const visible = r4.compile("(status in ('entered-in-error' | 'draft')).not()", 'MedicationRequest')
```

The declaration improves TypeScript inference and gives source-based analyzers
the expression context. It is not checked at runtime.

### `evaluateTyped()`

Returns internal `TypedValue[]` values instead of unwrapped JavaScript values.
Each item includes its FHIRPath type. Decimal, Quantity, date, time, and dateTime
values keep their internal exact representations.

## Stateless API

The package root also exports stateless forms:

```ts
import { compile, evaluate, fhirpath } from 'fhirpath-ts'
import { r4Model } from 'fhirpath-ts/r4'

evaluate('Patient.name.given', patient, { model: r4Model }) // unknown[]
compile('Patient.name.given').evaluate(patient, { model: r4Model }) // string[]
fhirpath('Patient.name.given').evaluate(patient, { model: r4Model }) // string[]
fhirpath`Patient.name.given`.evaluate(patient, { model: r4Model }) // unknown[]
```

Tagged templates remain untyped because TypeScript does not preserve their
literal types. The call form and `compile()` do preserve them. Without a model,
the stateless evaluator navigates plain JSON.

## Options

Engine construction and evaluation calls share these options. Per-call values
replace engine defaults, except `env` and `functions`, which merge by name.

| Option | Meaning |
| --- | --- |
| `model` | A `ModelProvider`; use `r4Model` for FHIR R4 |
| `env` | Plain host values available as `%name` |
| `vars` | FHIRPath bindings evaluated against the input |
| `now` | Clock for `now()`, `today()`, and `timeOfDay()` |
| `trace` | Sink for `trace()` calls |
| `functions` | Host or expression-defined functions |
| `regex` | Regular expression implementation |
| `cacheSize` | Engine parse-cache capacity; construction only |

### `env` and `vars`

Both accept keys with or without `%`. Both merge by name between engine defaults
and call options. They hold different kinds of values:

- `env` contains plain JavaScript data such as URLs, lookup tables, and request
  parameters.
- `vars` contains FHIRPath expressions evaluated against the call input. Their
  results keep FHIRPath type information.

```ts
fp.evaluate('%threshold + 1', patient, { env: { threshold: 5 } })

fp.project(observations, columns, {
  vars: { weight: 'value.ofType(Quantity)' },
})
```

Variables are evaluated in declaration order, so a later variable may use an
earlier one. A variable cannot replace an environment value, including built-in
values such as `%loinc`.

During projection, variables are evaluated once per row. `%context`,
`%rowIndex`, and `%rowTotal` are in scope. Every column reads the same bindings.

### Fixed clocks

Pass `now` when tests or application logic need repeatable answers:

```ts
fp.test(patient, 'birthDate <= today()', {
  now: new Date('2026-08-04T12:00:00Z'),
})
```

### Tracing

`trace()` calls the provided sink. It does not log by default:

```ts
fp.evaluate("name.trace('names').given", patient, {
  trace: (name, values) => debugSink(name, values),
})
```

Traced values may contain PHI. Keep them out of production logs.

## Custom functions

A custom function record defines runtime behavior and, optionally, its analyzer
signature:

```ts
import type { CustomFunction } from 'fhirpath-ts'

const functions = {
  initials: {
    minArity: 0,
    maxArity: 0,
    signature: {
      input: { kind: 'String' },
      result: { types: ['System.String'], single: false },
    },
    fn: (input: unknown[]) => input.map(value => String(value).charAt(0)),
  },
} satisfies Record<string, CustomFunction>
```

Arguments are evaluated before `fn` is called. Plain JavaScript values cross the
function boundary. Built-in names cannot be replaced.

Without a signature, the analyzer treats the result as unknown and resumes
checking after a later `as()` or `ofType()` narrows it.

### Expression-defined functions

Use `expression` instead of `fn` for a zero-argument function written in
FHIRPath:

```ts
const functions = {
  displayText: {
    expression: '(text | coding.display.first() | coding.first().code).first()',
    signature: {
      input: { types: ['CodeableConcept'] },
      result: { types: ['System.String'], single: true },
    },
  },
} satisfies Record<string, CustomFunction>
```

The body receives the call focus. `%context` and environment values remain the
caller's. Results keep FHIRPath type information. Direct or indirect recursion is
an error.

Set `criteria: true` when the function should always return one boolean using
the same rules as `test()`:

```ts
const functions = {
  isFinal: {
    expression: "status = 'final'",
    criteria: true,
  },
} satisfies Record<string, CustomFunction>
```

`signature.input.types` limits the focus types that may call a function. The
runtime and analyzer report a mismatch only when the model can prove that no
input type fits. Empty or unknown focus types remain allowed.

## DTOs

A DTO is a class created from `defineDto(fhirType)`. Each decorated field is a
projection column:

```ts
import { column, criteria, defineDto } from 'fhirpath-ts'

class WeightRow extends defineDto('Observation') {
  @column("value.ofType(Quantity).toQuantity('[lb_av]').value", { default: 0 })
  lbs!: number

  @column('(effective.ofType(dateTime) | issued).first()', { as: 'Date' })
  at!: Date | undefined

  @criteria("status = 'final'")
  final!: boolean

  get rounded(): number {
    return Math.round(this.lbs)
  }
}

const rows = fp.project(observations, WeightRow) // WeightRow[]
```

The field type is checked against the inferred column type. The decorator accepts
the same options as a plain project column. Rows are class instances, so derived
values can be getters or methods.

### Decorator compilation

These are standard JavaScript decorators. TypeScript must compile them with a
target of ES2024 or lower. SWC and Babel can also lower them. esbuild, oxc, and
Node's type stripping do not currently lower standard decorators.

Use a plain column record if the build cannot compile decorators.

### Registering DTO columns as functions

Pass DTOs through `resourceDtos` to call their columns from other expressions:

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

Registration publishes every column under its field name. Each function accepts
the DTO's `fhirType`. A model is required so the engine can reject calls on an
incompatible focus.

Names are scoped by input type. A CodeableConcept DTO and a Coding DTO may both
declare `displayText`. The call focus selects the matching declaration.

Engine construction fails when two declarations with the same name cannot be
distinguished. This includes two DTOs on the same FHIR type, overlapping input
types such as Quantity and SimpleQuantity, and a DTO name already accepted by a
host function. Built-in names are always reserved.

Several DTOs may target the same FHIR type when their field names are different.

### DTO environment values

Use `static env` for lookup values owned by a DTO:

```ts
class LabRow extends defineDto('DiagnosticReport') {
  static env = { system: 'http://loinc.org' }

  @column('code.coding.where(system = %system).first().code', {
    type: 'string',
    default: '',
  })
  loincCode!: string
}
```

These values are available only while evaluating that DTO's columns. Registering
the DTO does not publish them to other engine expressions. A DTO value has higher
priority than the engine and per-call environment values with the same name.

Declare data supplied by each projection with `callerEnv`:

```ts
class LabResultRow extends defineDto('ServiceRequest', {
  callerEnv: ['reports'],
  vars: { report: '%reports.where(orderId = %context.id).report' },
}) {
  @column('%report.status', { type: 'string', default: 'waiting' })
  status!: string
}
```

`callerEnv` tells the analyzer which names the call provides. It does not create
values. Pass them to `project()` through `env`.

DTO `vars` apply only when the DTO is projected. They are row expressions and do
not travel with a registered function call, which has a focus but no projection
row.

### Inheritance

Subclasses inherit columns, variables, and environment values. Environment
records merge by key:

```ts
class BaseRow extends defineDto('Observation') {
  static env = { unit: 'kg', label: 'Reading' }
}

class PoundsRow extends BaseRow {
  static override env = { unit: '[lb_av]' }
}
```

Annotate a base environment as `DtoEnv` when a subclass should override only
part of a record. An inferred literal type may otherwise require every base key.

### Input checks

`project()` checks each resource's `resourceType` against the DTO `fhirType`.
Filter a mixed search Bundle before projecting it:

```ts
const patients = fp.filter(searchset, '$this is Patient')
const rows = fp.project(patients, PatientRow)
```

This prevents a well-typed row filled only with defaults when the input resource
has the wrong type.

### Checking DTOs

Use the analyzer in unit tests:

```ts
import { analyzeDto, analyzeEngineDtos } from 'fhirpath-ts/analyzer'

expect(analyzeDto(LabResultRow, { engine: fp })).toEqual([])
expect(analyzeEngineDtos(fp)).toEqual([])
```

`analyzeDto()` checks the complete expression language against the engine model,
functions, and environment. It also compares a declared column `type` or `enum`
with the analyzer's inferred result.

`analyzeEngineDtos()` checks only registered DTOs. Use the
[`fhirpath-check` DTO scan](static-checking.md#dto-discovery) to find exported DTOs
that are used only for projection.

## Bundles

Application helpers treat a search Bundle as its entry resources. An expression
rooted at `Bundle` still receives the Bundle itself:

```ts
r4.evaluate('Patient.name.given', searchset)
r4.evaluate('Bundle.entry.count()', searchset)
```

A relative expression on a bare Bundle is ambiguous and throws. Wrap the Bundle
in an array when it should be treated as one resource:

```ts
r4.evaluate('Bundle.type', [searchset])
```

A search Bundle may include resources of several types through `_include` and
`_revinclude`. Filter before projecting a DTO. To keep only search matches, read
entries where `search.mode = 'match'`.

## Parse caching

Each engine has a private LRU parse cache. The default capacity is
`DEFAULT_PARSE_CACHE_SIZE` (500). Set `cacheSize: 0` to disable it.

```ts
const fp = new FhirPathEngine({ model: r4Model, cacheSize: 2000 })
```

The value is read only at construction. Compiled expressions do not use the
cache. Keep a long-lived engine instead of creating one per request, and pass
request-specific values through call options.

## Medplum types

`fhirpath-ts/r4` and `@medplum/fhirtypes` are generated from the same R4
StructureDefinitions. Medplum resources can be passed directly to this engine.

This package keeps every generated field optional, including fields that FHIR
marks as required. The types describe data that can be navigated; they are not a
profile validator. Required code bindings use generated literal unions where the
code set is practical.

Pass explicit generics to use Medplum types for both input and result:

```ts
import type { HumanName, Patient } from '@medplum/fhirtypes'
import { compile } from 'fhirpath-ts'
import { r4Model } from 'fhirpath-ts/r4'

const names = compile<'Patient.name', Patient, HumanName[]>('Patient.name')
names.evaluate(patient, { model: r4Model })
```
