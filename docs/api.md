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

### Strict evaluation

Evaluation is lenient by default: invalid model members navigate to an empty
collection. Set `strict: true` on an engine to run the analyzer before every
evaluation and throw `FhirPathTypeError` when it reports an error:

```ts-invalid
const strict = new FhirPathEngine({ model: r4Model, strict: true })

strict.evaluate('Patient.name.givenn', patient)
// FhirPathTypeError: Strict evaluation failed:
// - [unknown-element] Element 'givenn' is not defined on FHIR.HumanName ...
```

`strict` is also an `EvaluateOptions` field, so one call can enable or disable
it:

```ts-invalid
r4.evaluate('Patient.name.givenn', patient, { strict: true })
strict.evaluate('Patient.name.givenn', patient, { strict: false }) // []
```

Strict evaluation rejects every error-severity analyzer diagnostic. Warnings,
including `regex-backtracking`, do not stop evaluation. It checks `vars` and
expression-defined custom functions with the same model, functions, and
environment declarations as the evaluator. FHIR member checks require a model;
values whose resource type is unknown to that model remain opaque.

Runtime contracts still apply in lenient mode. Unknown functions and variables,
wrong function arguments, invalid type names, and invalid cardinality are
evaluation errors required by FHIRPath; `strict` does not control them. See
[What throws errors and what doesn't?](#what-throws-errors-and-what-doesnt) for
the full boundary.

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
| `required` | DTO columns only: the input must carry this path; see [Required columns](#required-columns) |

`type` is a TypeScript declaration. The runtime does not validate it. Use the
analyzer or a DTO check when an expression falls outside TypeScript's inference
subset.

Each row evaluates with `%rowIndex` and `%rowTotal`. Indexes are zero-based. A
single resource gets index `0` and total `1`.

`project()` creates application data. Structure-to-structure transformation is
the job of StructureMap and the FHIR Mapping Language.

### `defineDto()`, `defineView()`, and `register()`

`engine.defineView(fhirType)` and `engine.defineDto(fhirType)` return base classes
for projected rows, and `engine.register(...dtos)` returns a new engine with DTO
columns as FHIRPath functions. See [DTOs](#dtos).

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

The result is inferred against the declared type, even when the input's static
type names no resource, such as parsed JSON. The input must be that type or an
array of it. Static checkers analyze the expression against it. It is not
checked at runtime. A Bundle cannot be declared, because the engine reads a
Bundle input as its entries; compile without a root to evaluate a Bundle.

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

Engine construction and evaluation calls share most options. Per-call values
replace engine defaults, except `env`, `vars`, and `functions`, which merge by
name.

| Option | Meaning |
| --- | --- |
| `model` | A `ModelProvider`; use `r4Model` for FHIR R4 |
| `env` | Plain host values available as `%name` |
| `envTypes` | Explicit types or refinements for `env` values |
| `vars` | FHIRPath bindings evaluated against the input |
| `varTypes` | Static declarations or explicit overrides for `vars` |
| `now` | Clock for `now()`, `today()`, and `timeOfDay()` |
| `trace` | Sink for `trace()` calls |
| `functions` | Host or expression-defined functions |
| `regex` | Regular expression implementation |
| `narrativeSanitizer` | HTML sanitizer `htmlChecks()` also requires to accept a narrative; see [Narrative checking](../README.md#narrative-checking) |
| `cacheSize` | Engine parse-cache capacity; construction only |
| `type` | Compile-time result declaration for `evaluate()` or `first()`; per-call only |

Use `type` when an expression is outside TypeScript's inference subset. It does
not perform a runtime check and cannot be set as an engine default.

Fresh literal option objects reject unknown keys, so a misspelling such as
`envTypez` fails at the call site. Reusable application options may extend
`EvaluateOptions` or `EngineOptions`, and index-signature records remain
assignable. These widened shapes opt out of exact-key checking and no longer
retain literal declarations for result inference.

A literal that spreads a value already typed as `EvaluateOptions` is also
widened, so the call cannot distinguish its explicit keys from a reusable
extension. Validate a composed object where it is built to catch an adjacent
typo:

```ts
const options = {
  ...baseOptions,
  envTypez: { report: { type: 'DiagnosticReport' } },
} satisfies EvaluateOptions // error: envTypez is not an option
```

Use `satisfies EngineOptions` instead for constructor-only fields. The exported
`Declaring<Options, Accepted>` type is the parameter shape used by generic
engine calls when a wrapper needs the same literal checks and widening rules.

### Type context declarations

Literal expressions infer primitive, resource, collection, and structural types
from `env`. Literal `vars` expressions can carry those types through property
navigation. Use `envTypes` or `varTypes` when a value is widened, ambiguous, or
needs an explicit override. Declarations do not create or validate values.

```ts
import type { EvaluateOptions } from 'fhirpath-ts'

const options = {
  env: { report },
} as const satisfies EvaluateOptions

const statuses = r4.evaluate('%report.status', undefined, options) // string[]
```

Each `FhirpathTypeDeclaration` has these fields:

| Field | Meaning |
| --- | --- |
| `type` | One R4/FHIRPath type name, or an array of possible type names |
| `collection` | Omit for at most one item; set `true` when many items are possible |
| `targets` | Resource targets for a declared `Reference`, used by `resolve()` |

Use `as const satisfies EvaluateOptions` when options are stored in a variable.
It checks the shape without widening the type-name literals. A literal `env`
value beside its declaration is also checked for compatible type and singleton
cardinality. Use declarations for pre-resolved `vars`, `Reference` targets, or
data whose TypeScript type is too broad. Explicit declarations take precedence.

`FhirpathTypeContext` is the declaration-only form used by `FhirpathResult` and
`FhirpathResultIn`. Its fields are named `env`, `vars`, and `functions`. Engine
and per-call options infer from values and accept `envTypes` and `varTypes` as
overrides. Names may include or omit their leading `%`.

Engine defaults and per-call declarations merge by normalized name, with the
per-call declaration winning. A `BoundExpression` returned by
`engine.compile()` keeps the engine declarations. A plain `CompiledExpression`
uses declarations supplied when it is evaluated. An explicit column or call
`type` remains the escape hatch for an opaque expression.

### Inference type exports

These package-root types support wrappers and compile-time assertions. Most
applications only need `FhirpathResult`, `FhirpathResultIn`, and the declaration
types.

| Type | Purpose |
| --- | --- |
| `FhirpathResult<Expr, Context>` | Infer a literal expression without an input root |
| `FhirpathResultIn<Expr, Input, Context>` | Infer a literal expression against a named input type |
| `FhirpathTypeDeclaration` / `FhirpathTypeDeclarations` | Declare host value types, collection shape, and Reference targets |
| `FhirpathTypeContext` / `FhirpathFunctionDeclaration` | Describe standalone env, var, and function declarations |
| `EmptyFhirpathTypeContext` / `EmptyContextMap` | Importable empty defaults used by context-aware generic wrappers and diagnostics |
| `CompiledExpressionResult` / `InferredExpressionResult` | Select and compute a compiled expression's inferred result |
| `EngineExpression` / `EngineInputRoot` | Describe accepted engine expressions and normalized input roots |
| `EngineResult` | Compute the inferred result of an engine or bound-expression call |
| `EngineProjectionContext` / `EngineProjection` | Compute projection declarations and row results |
| `Declaring<Options, Accepted>` | Preserve literal option inference with fresh-literal key checks |

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

TypeScript does not retain object-property declaration order. Type inference
can use `env`, the input, and explicit declarations while reading a literal
variable body, but it does not assume that another expression variable ran
first. Use `varTypes` for that dependency. Runtime evaluation and the analyzer
still honor declaration order.

During projection, variables are evaluated once per row. `%context`,
`%rowIndex`, and `%rowTotal` are in scope. Every column reads the same bindings.

### Fixed clocks

Pass `now` when tests or application logic need repeatable answers:

```ts
r4.test(patient, 'birthDate <= today()', {
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
      result: { types: ['System.String'], single: false, ordered: true },
    },
    fn: (input: unknown[]) => input.map(value => String(value).charAt(0)),
  },
} satisfies Record<string, CustomFunction>
```

Arguments are evaluated before `fn` is called. Plain JavaScript values cross the
function boundary. Built-in names cannot be replaced.

The native signature's result supplies both analyzer and TypeScript inference.
Set the result's `ordered` when a collection result has a defined or undefined
order; omit it when ordering is unknown. Set `input: { ordered: true }` when the
function needs a defined input order, like the built-in `first()` and `skip()`;
the analyzer then rejects calls on a collection known to be unordered. Without a
result signature, the result is unknown and checking resumes after a later
`as()` or `ofType()` narrows it.

### Expression-defined functions

Use `expression` instead of `fn` for a zero-argument function written in
FHIRPath. It accepts a string or a compiled expression. Compiling with an input
type lets static checking validate the relative path:

```ts
import { compile, type CustomFunction } from 'fhirpath-ts'

const functions = {
  displayText: {
    expression: compile('(text | coding.display.first() | coding.first().code).first()', 'CodeableConcept'),
    signature: {
      input: { types: ['CodeableConcept'] },
    },
  },
} satisfies Record<string, CustomFunction>
```

The body receives the call focus. `%context` and environment values remain the
caller's. Results keep FHIRPath type information. Direct or indirect recursion is
an error. A literal body supplies its result type to callers. Add a signature
result for a widened body, or use the manual call `type` escape hatch when the
function is intentionally opaque. Function-local `env` values infer the same
way as engine values; add `envTypes` only when they need refinement.

Set `criteria: true` when the function should always return one boolean using
the same rules as `test()`:

```ts
import { compile, type CustomFunction } from 'fhirpath-ts'

const functions = {
  isFinal: {
    expression: compile("status = 'final'", 'Observation'),
    criteria: true,
  },
} satisfies Record<string, CustomFunction>
```

`signature.input.types` limits the focus types that may call a function. The
runtime and analyzer report a mismatch only when the model can prove that no
input type fits. Empty or unknown focus types remain allowed.

An overloaded function carries the declarations of each overload. A statically
known focus selects the first compatible declaration, matching runtime dispatch.
If the focus cannot distinguish the overloads safely, TypeScript keeps the
result opaque.

## DTOs

DTOs and views are classes defined on an engine. Each field initialized with
`this.column()` or `this.criteria()` is a projection column, and its type is
inferred from the expression:

```ts
import { r4 } from 'fhirpath-ts/r4'

class WeightRow extends r4.defineView('Observation') {
  lbs = this.column("value.ofType(Quantity).toQuantity('[lb_av]').value", { default: 0 }) // number
  at = this.column('(effective.ofType(dateTime) | issued).first()', { as: 'Date' }) // Date | undefined
  notes = this.column('note.text', { collection: true }) // string[]
  final = this.criteria("status = 'final'") // boolean

  get rounded(): number {
    return Math.round(this.lbs)
  }
}

const rows = WeightRow.from(observations) // WeightRow[]
```

`Dto.from(input, options?)` projects on the engine the class was defined on;
`engine.project(input, Dto, options?)` does the same on that engine or one
derived from it. Both accept one resource, an array, or a Bundle, and return one
row per resource. See [Inputs](#inputs) for what the input type demands.

There are two kinds:

- `engine.defineDto(fhirType, options?)` defines a DTO whose columns become
  FHIRPath functions once it is registered. It holds only columns and methods.
- `engine.defineView(fhirType, options?)` defines a projected row. A view may
  also hold getters and plain fields, and its columns may convert values with
  `as` or `choices`.

`this.column()` accepts the same options as a plain project column. Rows are class
instances, so derived values can be getters or methods. Plain fields of a view
keep their ordinary JavaScript behavior and are not projected.

A field may also declare its type. TypeScript then checks that the declared type
can hold the column value:

```ts
class ReportRow extends r4.defineView('DiagnosticReport') {
  issued: string | undefined = this.column('issued')
}
```

When TypeScript cannot infer an expression, the field type is `unknown`.
`combine()`, caller values without a declared type, and calls to a column of the
same class are the common cases. TypeScript cannot type a call to a column of the
class being defined, because a field's type cannot depend on its own class. Set
the column `type` option to give the field a type. `analyzeDto()` checks that
option when it can infer the expression result; otherwise the option is an
unchecked assertion.

Write each column as the whole initializer of a public instance field. Projection
reads columns by constructing the class once, and it reports a column in a
private field, a static field, or a nested value.

### Registering DTOs

`engine.register(...dtos)` returns a new engine on which every column of those
DTOs is a FHIRPath function. The engine it is called on does not change.

```ts
class CodeableConceptDto extends r4.defineDto('CodeableConcept') {
  displayText = this.column('(text | coding.display.first() | coding.first().code).first()')
}

const fp = r4.register(CodeableConceptDto)

fp.first('Condition.code.displayText()', condition) // string | undefined
```

Registration publishes every column under its field name. Each function accepts
the DTO's `fhirType`. A model is required so the engine can reject calls on an
incompatible focus.

The new engine's type includes the registered functions, so calls to them are
typed in engine calls and in the columns of DTOs and views defined on it. A
TypeScript `string` column may hold any FHIR type represented as a string, so its
call result is the union of those types; `ofType(code)` keeps the value. A column
whose value no FHIR type represents, such as a lookup-table row, keeps an
`unknown[]` call result.

A registered column is also a function that returns its expression's own result,
without `default` or other projection options. `register()` therefore accepts
only DTOs from `defineDto()` on that engine or an engine it derives from. It
rejects views, getters, and plain fields, because the engine's types read every
non-method field of a registered DTO as a column.

Names are scoped by input type. A CodeableConcept DTO and a Coding DTO may both
declare `displayText`. The call focus selects the matching declaration.

Registration fails when two declarations with the same name cannot be
distinguished. This includes two DTOs on the same FHIR type, overlapping input
types such as Quantity and SimpleQuantity, and a DTO name already accepted by a
host function. Built-in names are always reserved.

Several DTOs may target the same FHIR type when their field names are different.
When one registered DTO calls another's column, define it on the engine that
already registers the callee:

```ts
const withConcepts = r4.register(CodeableConceptDto)

class MedicationRequestDto extends withConcepts.defineDto('MedicationRequest') {
  medicationName = this.column('medication.ofType(CodeableConcept).displayText()') // string | undefined
}

export const fp = withConcepts.register(MedicationRequestDto)
```

### Engines and file layout

Build every registered DTO in one `*.dto.ts` module: define the DTOs, register
them, and export the final engine. Views may live anywhere in the codebase. Each
view module imports that engine and extends `engine.defineView(...)`:

```ts
// patient-portal.dto.ts
export class CodeableConceptDto extends r4.defineDto('CodeableConcept') {
  displayText = this.column('(text | coding.display.first() | coding.first().code).first()')
}
export const fp = r4.register(CodeableConceptDto)
```

```ts
// problems/problem-row.ts
import { fp } from '../patient-portal.dto'

export class ProblemRow extends fp.defineView('Condition') {
  name = this.column('code.displayText()', { default: 'Condition' }) // string
}
```

A custom engine works the same way as `r4`: build it with
`new FhirPathEngine(options)`, define DTOs on it, and register them. Columns see
the engine's `env` and typed functions. Engine `vars` stay untyped in columns,
because a registered column called inside another expression evaluates them
against that expression's resource.

A DTO or view projects on the engine it was defined on and on engines derived
from it with `register()`. `project()` on any other engine throws. A column body
always reads the engine's `env` and calls the engine's functions, projected or
called, so a per-call value or function of the same name does not reach it: the
columns' types came from the engine's own.

### DTO environment and variables

Use `env` for lookup values owned by a DTO:

```ts
class LabRow extends r4.defineView('DiagnosticReport', {
  env: { system: 'http://loinc.org' },
}) {
  loincCode = this.column('code.coding.where(system = %system).first().code', {
    default: '',
  })
}
```

These values are available only while evaluating that DTO's columns. Registering
the DTO does not publish them to other engine expressions. Column types are
inferred from the values, so a lookup table types the columns that read it.

Declare data supplied by each projection with `callerEnv`. A declaration map
types the supplied values, and DTO vars carry that type into later columns:

```ts
class LabResultRow extends r4.defineView('ServiceRequest', {
  callerEnv: { reports: { type: 'DiagnosticReport', collection: true } },
  vars: { report: "%reports.where(basedOn.reference = 'ServiceRequest/' + %context.id).first()" },
}) {
  status = this.column('%report.status', { default: 'waiting' }) // string
}
```

`callerEnv` tells TypeScript and the analyzer which names the call provides. Use
an array of names when their structure is intentionally opaque, or a declaration
map when FHIRPath navigates through them. It does not create values. Pass them to
`project()` through `env`. A name cannot be both in `env` and in `callerEnv`, and
it cannot be a name the engine's `env` binds.

DTO `env` and `vars` take priority over engine and per-call values with the same
name, and the engine's `env` and functions take priority over per-call ones, so
a column means the same thing however it is reached. `%rowIndex` and
`%rowTotal` are also available to every column.

DTO `vars` apply only when the DTO is projected. They are row expressions and do
not travel with a registered function call, which has a focus but no projection
row.

### Inheritance and shared columns

Subclasses inherit columns, environment values, and variables. A subclass can add
columns, or replace an inherited column with a field of the same name:

```ts
class ObservationRow extends r4.defineView('Observation') {
  at = this.column('(effective.ofType(dateTime) | issued).first()', { as: 'Date' })
}

class HeightRow extends ObservationRow {
  meters = this.column("value.ofType(Quantity).toQuantity('m').value", { default: 0 })
}
```

Columns shared by DTOs and views on different FHIR types come from a base
defined on a model base type: `Resource` for every resource, `DomainResource`
for the resources that carry `text` and `extension`, or the same type for plain
composition. Pass it as `base`:

```ts
class ResourceDto extends fp.defineDto('Resource') {
  id = this.column('id', { required: true })
  lastUpdated = this.column('meta.lastUpdated')
}

class ProblemRow extends fp.defineView('Condition', { base: ResourceDto }) {
  status = this.column('clinicalStatus.coding.first().code')
}

ProblemRow.from(condition) // ProblemRow { id, lastUpdated, status }; the input must carry `id`
```

The subclass extends the base class: it inherits the base's columns, methods,
and getters, and a redeclared column overrides. It also inherits the base's
`env`, `vars`, and `callerEnv`, and its own columns are inferred in the merged
context. A name the base binds cannot be rebound, because the inherited columns
were typed against the base's binding. A required column of the base is
required by every subclass. `analyzeDto()` checks an inherited column against
the root it was written for, so a column that dispatches on the resource type
stays valid on every subclass.

The rules: a DTO takes a DTO as base, a view takes a DTO or a view; the base root
is the root itself or one of its model base types (without a model, only the
same root); the base was defined on the same engine or one the engine derives
from. A base on an ancestor root projects any resource of that root, so
`ResourceDto.from(resource)` accepts every resource type. Register the
subclasses, not the base: an inherited column registered for both roots is an
overlap `register()` rejects.

When shared columns depend on options each subclass passes, a function that
forwards them to `defineView()` still works. Its return type is needed only when
an exported class extends the result and the project emits declaration files;
`ViewBaseClass` names the base class that engine's `defineView()` returns, plus
the columns the function adds:

```ts
function badgedRow<const Root extends FhirTypeName, const Options extends DtoOptions = DtoOptions>(
  fhirType: Root,
  options?: Options
): ViewBaseClass<typeof fp, Root, Options, { badge: string }> {
  return class BadgedRow extends fp.defineView(fhirType, options) {
    badge = this.column('%badge', { type: 'string', default: '' })
  }
}

class LabRow extends badgedRow('DiagnosticReport', { vars: { badge: 'reportBadge()' } }) {
  name = this.column('code.text')
}
```

### Inputs

A DTO or view on a resource type accepts a value whose `resourceType` is that
type: `{ resourceType: 'Patient' }`, a generated or `@medplum/fhirtypes`
`Patient`, an array of them, or a Bundle. Any other type is a compile error,
including `unknown` and `{ resourceType: string }`. A datatype root such as
`CodeableConcept` accepts any object. `DtoInput<typeof Dto>` names the accepted
input.

A Bundle is accepted as a whole by a DTO without required columns, so its
entries are checked only at runtime: each entry resource must carry the DTO's
`fhirType` or a type deriving from it in the model, or `project()` throws. A
DTO with a required column refuses a Bundle at compile time, because an entry
cannot prove the path; read the entries with `ofType()` and narrow them. A value
that is not an object, or has no `resourceType`, is rejected the same way. To
project one resource type out of a mixed search Bundle, read the entries with
`ofType()`, which infers the resource type:

```ts
const patients = r4.evaluate('Bundle.entry.resource.ofType(Patient)', searchset) // Patient[]
const rows = PatientRow.from(patients)
```

To keep only search matches, add `where(search.mode = 'match')` on the entries.

#### Required columns

`required: true` marks a column whose path the input must carry. The requirement
is on the input type, not a check at read time: the accepted input gains the path
as a required property, and the field's type drops `undefined` because the input
proves presence.

```ts
class ScheduledAppointmentRow extends r4.defineView('Appointment') {
  id = this.column('id', { required: true }) // string
  start = this.column('start', { required: true }) // string
  lastUpdated = this.column('meta.lastUpdated', { required: true }) // string
  end = this.column('end') // string | undefined
}

type ScheduledAppointment = DtoInput<typeof ScheduledAppointmentRow>
// { resourceType: 'Appointment'; id: string; start: string; meta: { lastUpdated: string } }

ScheduledAppointmentRow.from(appointment) // compiles only when `appointment` has those properties
```

`required` is allowed only on a path of singular element names from the root,
such as `id` or `meta.lastUpdated`. An expression, a collection element, a
choice element, or a root-prefixed path is a compile error; use `default` to
drop `undefined` from such a column. `required` excludes `default`,
`collection`, `as`, `choices`, and `enum`, because each of those can replace or
drop the value, and `type`, because a singular model path already has an exact
type. A required column of a base class is required by every subclass.

The field type carries the path it requires, as `string & RequiredColumn<'id'>`.
The marker is an optional symbol property, so the field reads and assigns as a
plain `string`.

There is no runtime check for `required`: a cast or a registered function call
that reaches a missing value reads `undefined` or empty, as any column does. The
only input that could reach a required column unchecked is a Bundle, so a class
with a required column refuses one; read the entries and narrow them.

Narrowing is the caller's job, and TypeScript narrows a property access, not
the object that holds it: after `if (appointment.start !== undefined)`,
`appointment` is still an `Appointment`. A named type guard is what a mapper
module writes, and it narrows an array through `filter()`:

```ts
type ScheduledAppointment = DtoInput<typeof ScheduledAppointmentRow> & Appointment

function isScheduled(appointment: Appointment): appointment is ScheduledAppointment {
  return appointment.id !== undefined && appointment.start !== undefined && appointment.meta?.lastUpdated !== undefined
}

const appointments = r4.evaluate('Bundle.entry.resource.ofType(Appointment)', bundle) // Appointment[]
ScheduledAppointmentRow.from(appointments.filter(isScheduled)) // ScheduledAppointmentRow[]
```

For one resource, either call the guard or rebuild the object from the narrowed
properties; a spread carries the narrowed types into a new object:

```ts
const { id, start } = appointment
const lastUpdated = appointment.meta?.lastUpdated
if (id !== undefined && start !== undefined && lastUpdated !== undefined) {
  ScheduledAppointmentRow.from({ ...appointment, id, start, meta: { ...appointment.meta, lastUpdated } })
}
```

### Checking DTOs

Use the analyzer in unit tests:

```ts
import { analyzeDto, analyzeEngineDtos } from 'fhirpath-ts/analyzer'

expect(analyzeDto(LabResultRow)).toEqual([])
expect(analyzeEngineDtos(fp)).toEqual([])
```

`analyzeDto()` checks the complete expression language against the model,
functions, and environment of the engine the DTO was defined on. It also compares a declared column `type` or `enum`
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
`_revinclude`. Read one type out of it with `Bundle.entry.resource.ofType(Patient)`
before projecting a DTO; see [Inputs](#inputs). To keep only search matches,
read entries where `search.mode = 'match'`.

## What throws errors and what doesn't?

By default, `evaluate()` does not run static analysis. FHIRPath uses an empty
collection for absence, so ordinary path navigation is lenient at runtime:

| Example | Result | Reason |
| --- | --- | --- |
| `r4.evaluate('Encounter.id', patient)` | `[]` | The root type does not match the input. |
| `r4.evaluate('Patient.telecom.value', patient)` | `[]` | The element is absent from this resource. |
| `r4.evaluate('Patient.name.givenn', patient)` | `[]` | An unknown path segment, including a misspelling, navigates to empty. |
| `r4.evaluate('Observation.valueQuantity', observation)` | `[]` | A choice JSON key is not a FHIRPath element; use the `Observation.value` stem. |
| `r4.evaluate('Patient.name[99]', patient)` | `[]` | The index is outside the collection. |

The `fhirpath-check` CLI, ESLint rule, analyzer API, and `strict: true`
evaluation report unknown or misspelled elements against the FHIR model.

The application helpers convert an empty result: `first()` returns `undefined`,
`test()` returns `false`, and `filter()` drops that input.

Engine-generated failures use these exported `FhirPathError` subclasses:

| Error | Example | Why it throws |
| --- | --- | --- |
| `FhirPathSyntaxError` | `r4.evaluate('Patient..name', patient)` | Parsing fails because the expression does not match the grammar. |
| `FhirPathTypeError` | `r4.evaluate('frobnicate()', patient)` | The function is unknown. Wrong argument types or counts and undefined `%variables` also throw this error. |
| `FhirPathTypeError` | `r4.evaluate('Patient.name.givenn', patient, { strict: true })` | Strict evaluation runs the analyzer and rejects its error diagnostics before reading data. |
| `FhirPathTypeError` | `r4.evaluate('Observation.valueQuantity', observation, { strict: true })` | A choice JSON key is an unknown path in FHIRPath; strict evaluation requires the `Observation.value` stem. |
| `FhirPathTypeError` | `r4.evaluate('Patient.children().skip(1)', patient, { strict: true })` | `children()` has undefined order, so strict analysis rejects the order-dependent `skip()`. |
| `FhirPathRuntimeError` | `r4.evaluate('(1 \| 2).single()')` | The operation requires at most one item, but the data contains two. |
| `FhirPathRuntimeError` | `r4.test(patient, 'Patient.name.given')` | A criteria result must contain at most one item. Bare search Bundle paths can also throw when their root is ambiguous. |

This follows FHIRPath's
[empty propagation and singleton evaluation rules](https://hl7.org/fhirpath/N1/#singleton-evaluation-of-collections)
and its
[type-safety and strict evaluation model](https://hl7.org/fhirpath/N1/#type-safety-and-strict-evaluation).
Caller-supplied callbacks, including
custom functions, conversions, regular expression engines, and trace sinks, may
throw their own errors; the engine does not swallow them. Use
[static checking](static-checking.md) to catch wrong paths and other expression
errors before runtime.

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

The generated interfaces require the elements FHIR marks as required (minimum
cardinality 1) and enumerate every required and extensible code binding the
definitions can list, with `Reference.type` as the resource names: a superset
of Medplum's enumerations, so a datatype result such as an `Extension`, an
`Address`, or a `Quantity` is assignable to the Medplum type without a cast.
Inferred results carry the union of a required binding:
`r4.evaluate('Observation.status', observation)` infers the status codes, while
`Reference.type` infers `string`, since an extensible binding admits other
codes. A whole resource is not assignable to Medplum's: `contained` and
`Bundle.entry.resource` hold any `{ resourceType }` here, while Medplum's
`Resource` is a closed union that also names Medplum's own resources.

Inputs stay lenient. A root-prefixed expression, a declared root, and a declared
host value accept `{ resourceType: 'Observation' }` with every other element
optional, because data read from a server, a fixture, or a form may be
incomplete. A misspelled property or status is still rejected; only a code set
that names resources, such as `Reference.type`, accepts any string, which is
what lets a Medplum resource in. The types are not a profile validator.

Pass explicit generics to use Medplum types for both input and result:

```ts
import type { HumanName, Patient } from '@medplum/fhirtypes'
import { compile } from 'fhirpath-ts'
import { r4Model } from 'fhirpath-ts/r4'

const names = compile<'Patient.name', Patient, HumanName[]>('Patient.name')
names.evaluate(patient, { model: r4Model })
```
