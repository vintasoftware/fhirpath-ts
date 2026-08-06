# fhirpath-ts

A TypeScript-native [FHIRPath](https://hl7.org/fhirpath/) engine with zero runtime
dependencies, verified against the official HL7 conformance suites, plus two things no
other implementation offers together:

- **Compile-time result types** for common expressions, in plain `tsc` with no plugin:
  `compile('Patient.name.given').evaluate(patient)` is a `string[]`.
- **A static analyzer for the official spec's §11**
  ([Type safety and strict evaluation](https://hl7.org/fhirpath/#typesafety)) that
  checks full expressions (unknown elements, wrong types, singleton misuse) at CI
  time, via a CLI or an ESLint rule.

## Why this engine

| | **fhirpath-ts** | fhirpath.js | fhirpath-py | fhirpath-rs | Medplum | HAPI / HL7 Java | helios-fhirpath | kotlin-fhirpath | HealthSamurai editor |
|---|---|---|---|---|---|---|---|---|---|
| Runtime deps | zero | ANTLR runtime, ucum-lhc, … | ANTLR runtime | Rust crates | none (large SDK) | org.hl7.fhir.core (Java) | Rust crates | ANTLR runtime (KMP) | n/a (block editor) |
| Decimal arithmetic | exact, always on | floats (opt-in precise mode) | Python decimal | Rust decimal | floats | BigDecimal | loses trailing zeros (documented) | precision 15, open TODO | n/a |
| Official R4+R5 suites in CI | 100% of non-skipped | not run | not run | regrouped R5 | not run | R4/R5 | R4 + R5, zero-failure | R4 only (6-platform matrix) | none |
| Runs the other engines' suites | yes, with evidence for each divergence | no | no | no | no | no | no | no | n/a |
| Compile-time result types | yes (plain `tsc`) | no | no | no | no | no | no | no | n/a |
| Spec §11 as dev tooling | CLI + ESLint + API | no | no | runtime analyzer | no | `check()` API | inference, display-only | no | editor inference |
| Terminology / async / `%factory` | deferred (see Gaps) | yes | partial | `%factory` | no | yes | — | — | n/a |
| FHIR models | R4 (provider interface) | DSTU2–R5 | DSTU2–R5 | R5 | R4 | DSTU2–R5 | R4 + R5 | R4/R4B/R5 (only R4 tested) | — |

(— means not assessed; n/a means out of scope for that tool.)

Three things set this engine apart.

**Expressions are checked before they run — and the checker itself is
conformance-tested.** The spec has had §11 for years, but the reference engines
treat it as at most a runtime mode. Here a typo like `Observation.valueQuantity`
or a singleton misuse is a build failure — caught by type inference in `tsc`,
the `fhirpath-check` CLI, or the ESLint rule — instead of an empty result in
production. The analyzer runs against both official suites: every strict-mode
and semantic-invalid case must produce an error diagnostic, and every valid case
must produce none, so it cannot drift into false positives. It types
`resolve()` from `Reference.targetProfile`, tracks `defineVariable()` scopes
exactly like the runtime, and host-supplied custom functions declare one record
— arity, signature, implementation — that the evaluator and the analyzer both
understand, so using a custom function never blinds the checker.

**Correctness is demonstrated against everyone else's tests, not just ours.** The
engine passes 100% of the non-skipped official suites plus the fhirpath.js and
fhirpath-py corpora, and every intentional divergence carries its spec citation.
Failing cases must fail in the phase the suite names — syntax at parse, semantic
as a type error, execution at runtime. On top of the fixed suites, property
tests check what example-based tests cannot: printer/parser round-trips over
generated ASTs, exact-decimal arithmetic laws, temporal comparison laws at mixed
precisions, and generated expressions evaluated differentially against
fhirpath.js. That process caught reference-implementation bugs this engine
refused to inherit: Medplum's `(0).not() = true` contradicts the official suite,
and fhirpath.js treats `1 month = 30 days` as true. A weekly job re-converts the
suites from `FHIR/fhir-test-cases@master` and flags new or changed cases.

**The engineering fits this repo.** Zero dependencies, consumed from source,
hardened against hostile expressions — including two ReDoS answers for
`matches()`: a static warning on backtracking-prone literal patterns and a
pluggable linear-time regex engine — and model-agnostic behind a provider
interface, so R5 and CDA are additive.

### Correctness practices across the field

The correctness work studied the strongest implementations in the field — HAPI
(the HL7 Java reference engine),
[helios-fhirpath](https://github.com/HeliosSoftware/hfs) (Rust),
[kotlin-fhirpath](https://github.com/ohs-foundation/kotlin-fhirpath) (Kotlin
Multiplatform), and the analyzer behind
[HealthSamurai's fhirpath-editor](https://github.com/HealthSamurai/fhirpath-editor)
— and adopted each practice that survived scrutiny. Same columns as above:

| Practice | **fhirpath-ts** | fhirpath.js | fhirpath-py | fhirpath-rs | Medplum | HAPI / HL7 Java | helios-fhirpath | kotlin-fhirpath | HealthSamurai editor |
|---|---|---|---|---|---|---|---|---|---|
| Failures land in the tagged phase | yes, with documented overrides | no | no | no | no | yes (the practice's origin) | no | no | n/a |
| Static checker tested against the suites | yes, both directions | n/a | n/a | — | n/a | via phase assertions | no | n/a | no (curated units only) |
| Custom functions visible to static checking | yes (one record for both) | runtime-only table | — | — | — | yes (resolve/check/execute) | no | no | n/a |
| `resolve()` typed from targetProfile | yes | n/a | n/a | — | n/a | yes | no | n/a | `resolve()` absent |
| Property + differential fuzzing | round-trips, value laws, vs fhirpath.js | — | — | — | — | none | none | none | none |
| Upstream suite drift watch | weekly re-convert + diff | — | — | — | — | no | releases blocked on upstream master | no | no |
| Skips documented with root causes | hygiene-checked manifests + README classes | — | — | — | — | — | reason-annotated failure list | skip registry + README table | n/a |
| ReDoS on `matches()` | static warning + pluggable engine | — | — | — | — | 500 ms regex timeout | none | none | n/a |

The trade-offs live in [Gaps and deferred features](#gaps-and-deferred-features).

## Quick start

```ts
import { r4 } from 'fhirpath-ts/r4'

// One import: a FhirPathEngine with the R4 model already bound.
r4.evaluate('Patient.name.given', patient) // string[] — compile + evaluate in one call
r4.first('Patient.name.family', patient)   // string | undefined — the scalar 90% case

// Compile once for hot paths; the engine's defaults stay bound:
const given = r4.compile('Patient.name.given')
given.evaluate(patient) // string[] — and `patient` must be a Patient

// Bundles and resource arrays work transparently — a searchset behaves as its
// entry resources, and expressions rooted at Bundle still see the bundle itself:
r4.evaluate('Patient.name.given', searchset)   // string[] across every Patient entry
r4.evaluate('Bundle.entry.count()', searchset) // the bundle, because the root is Bundle
r4.evaluate('Bundle.type', [searchset])        // wrap in an array to force one-resource treatment
r4.evaluate('entry.count()', searchset)        // throws: a bare Bundle element is ambiguous —
                                               // start at Bundle, or wrap the input in an array
```

Engine methods parse on demand (LRU-cached by expression text) and infer result
and input types from literal expressions in plain `tsc` — see
[Static checking](#static-checking-official-spec-11). The bound model gives
FHIR-aware evaluation: choice elements by stem name (`Observation.value`),
primitive `_field` extensions, and type checks (`is`/`as`/`ofType`). Unknown
elements navigate to empty like the reference engines (typos are the static
analyzer's job); the one runtime semantic error is choice-key misuse
(`Observation.valueQuantity`).

Need different defaults — `%env` variables, a fixed clock, a trace sink, another
model? Construct your own engine; per-call options override its defaults field
by field, except `env` and `functions`, which merge per name — per-call entries
add to the bound ones and win on the same name:

```ts
import { FhirPathEngine } from 'fhirpath-ts'
import { r4Model } from 'fhirpath-ts/r4'

const fp = new FhirPathEngine({ model: r4Model, env: { threshold: 5 } })
fp.evaluate('%threshold + 1') // [6]
```

### The main FHIRPath jobs, as helpers

FHIRPath earns its keep in FHIR doing a few specific jobs — extracting values,
checking invariants, filtering by criteria, shaping data — and the engine has a
helper for each:

```ts
// Criteria — the boolean semantics FHIR invariants, Subscription criteria, and
// Questionnaire enableWhen share (spec §4.5): empty → false, one boolean → itself.
r4.test(patient, "name.family = 'Chalmers'")   // boolean
r4.filter(patients, 'birthDate < @1990-01-01') // Patient[] — arrays and Bundles alike

// Invariants, shaped exactly like ElementDefinition.constraint:
const result = r4.checkConstraints(patient, [
  { key: 'pat-1', severity: 'error', human: 'Contact needs a name or telecom',
    expression: 'contact.all(name.exists() or telecom.exists())' },
])
result.valid                // false only if an error-severity constraint failed
result.issues               // the failed constraints, echoing their definitions
result.toOperationOutcome() // FHIR-native report (issue.code = 'invariant')

// Shape a resource into a typed row, following SQL-on-FHIR ViewDefinition column
// semantics: columns are scalars; more than one value is an error (append first()
// or opt into collection: true). Each column's type is inferred from its expression;
// when the expression is outside the inference subset, declare it with `type`
// (mirroring ViewDefinition column.type — a compile-time assertion, unchecked at runtime).
r4.project(patient, {
  id: 'Patient.id',                                         // string | undefined
  family: 'Patient.name.family.first()',                    // string | undefined
  given: { path: 'Patient.name.given', collection: true },  // string[]
  name: "Patient.name.given.join(' ')",                     // string | undefined
  born: { path: 'Patient.birthDate', as: 'Date' },          // Date | undefined — see below
  gender: { path: 'Patient.gender', default: 'unknown' },   // string — default fills empty AND types away undefined
  isActive: { test: 'Patient.active = true' },              // boolean — criteria column, test() semantics
})
r4.project(searchset, { id: 'Patient.id' }) // arrays and Bundles: one row per resource

// Every column evaluates with %rowIndex/%rowTotal set to the row's position (0/1 for a
// single resource), so a row key can fall back to the row number:
r4.project(searchset, { key: '(Patient.id | %rowIndex.toString()).first()' }) // string | undefined, inferred

// `as: 'Date'` coerces a column to JS Dates: partial dates become the UTC start of
// their period, and an unparseable value coerces to empty (the toX() contract).
// `as` also takes a function over each value — the escape hatch for display-ready
// shaping; its return type becomes the column type. `default` fills an empty result
// with a plain JS value (FHIRPath has no null, so this is also how a column yields
// one) and substitutes for `undefined` in the column's type — with unions covering
// in-expression fallbacks and these two covering the rest, a view-model mapper can
// be a project() call with no .map() after it.
// `evaluate` and `first` accept the same `type` declaration a column does, for
// expressions outside the inference subset — per-call only, never an engine default:
r4.first("Patient.name.select(family & ', ' & given.first())", patient, { type: 'string' })
```

Arrays and Bundles flow through all of these: `filter` and `project` iterate the
resources, and `checkConstraints` checks each one — its issues then carry the
failing position as `index`, and for Bundles the OperationOutcome points at
`Bundle.entry[i].resource`. A Bundle is validated as a resource in its own right
(e.g. against the `bdl-*` invariants) by wrapping it: `checkConstraints([bundle], …)`.

Two scope notes, so the names don't overpromise: `checkConstraints` evaluates
constraint *expressions* only — it is not full profile validation (no cardinality,
bindings, or slicing). And `project` shapes values *out of* a resource;
structure-to-structure mapping is the FHIR Mapping Language / StructureMap's job,
where FHIRPath is just the expression component.

### Low-level API

The engine wraps a smaller stateless layer that stays public — the same options,
passed per call:

```ts
import { evaluate, compile, fhirpath } from 'fhirpath-ts'
import { r4Model } from 'fhirpath-ts/r4'

// One-off evaluation (LRU-cached parse), untyped results:
evaluate('Patient.name.given', patient, { model: r4Model }) // unknown[]

// Compile once, reuse; literal expressions infer result and input types:
compile('Patient.name.given').evaluate(patient, { model: r4Model }) // string[]

// The fhirpath() call form is equivalent; the tag form works but stays untyped
// because TypeScript cannot carry literal types through tagged templates (TS#33304):
fhirpath('Patient.name.given').evaluate(patient, { model: r4Model }) // string[]
fhirpath`Patient.name.given`.evaluate(patient, { model: r4Model }) // unknown[]
```

Without a model (engine default or per-call), the engine navigates raw JSON.

### Options

`new FhirPathEngine(options)` and every evaluate-family call's trailing
`options` argument accept the same fields (per-call wins), plus `cacheSize`,
which the engine keeps for itself:

| Option | Meaning |
| --- | --- |
| `model` | A `ModelProvider`; use `r4Model` from `fhirpath-ts/r4` |
| `env` | Environment variables: `{ myVar: 5 }` resolves `%myVar` |
| `vars` | FHIRPath variable bindings, evaluated against the input — see below |
| `now` | Evaluation clock for `now()`/`today()`/`timeOfDay()` (deterministic tests) |
| `trace` | Sink for `trace()` calls — see the PHI note below |
| `functions` | Host-supplied functions — see Custom functions below |
| `cacheSize` | Parse-cache capacity, at construction only — see Parse caching below |

`evaluateTyped(...)` (on the engine, bound expressions, and compiled expressions)
returns the internal `TypedValue[]` (type names plus `Decimal`/`Temporal` value
objects) instead of unwrapped JS values.

#### `env` vs `vars`

Both resolve `%name` references, both accept keys with or without the leading
`%`, and both merge per name between the engine's bound defaults and a
per-call record. They differ in what crosses the host boundary:

- `env` carries host **data**: plain JS values, wrapped as-is. Lookup tables,
  system URLs, request parameters.
- `vars` carries **derived bindings**: each entry is a FHIRPath expression the
  engine evaluates against the call's input — `%context`, `env`, and earlier
  vars are in scope — and binds with full type fidelity. A var holding a
  dateTime compares as a dateTime; a var holding a Quantity keeps unit
  arithmetic. Env data enters untyped, so
  `env: { w: { value: 72.5, unit: 'kg' } }` can never satisfy `%w > 70 'kg'`,
  but `vars: { w: 'value.ofType(Quantity)' }` does.

`vars` is the option form of `defineVariable()` and follows its rules: entries
bind in declaration order (later vars can reference earlier ones), and a var
may not override an environment variable — including built-ins like `%loinc` —
that throws instead of shadowing. In `project()`, vars resolve once per row,
with the row as focus and `%rowIndex`/`%rowTotal` in scope, and every column
reads the same bindings — the join recipe below shows why that matters. A
`readonly TypedValue[]` value (say, a previous `evaluateTyped()` result) binds
directly without evaluation.

### Custom functions

A custom function is a HAPI-style triple on one record — resolve (name +
arity), check (optional `signature`, for the analyzer), execute (`fn`).
Plain JS values cross the boundary in both directions, arguments are eager,
and built-in names cannot be overridden:

```ts
const functions = {
  initials: {
    minArity: 0,
    maxArity: 0,
    // The static-typing leg: without it, expressions using initials() analyze
    // as unknown regions (still sound, just unchecked past the call).
    signature: { input: { kind: 'String' }, result: { types: ['System.String'], single: false } },
    fn: (input: unknown[]) => input.map(v => String(v).charAt(0)),
  },
} satisfies Record<string, CustomFunction>

evaluate('name.given.initials()', patient, { functions })
analyzeExpression('name.given.initials()', { model: r4Model, inputType: 'Patient', functions })
```

The same record works for both calls. Environment variables get the matching
treatment on the static side: `AnalyzeOptions.variables` declares the `%vars`
the host will pass (optionally with their types), so the analyzer can check
them instead of flagging `unknown-variable`. When checking `project()` column
expressions, declare `rowIndex` and `rowTotal` there too — the runtime sets
them per row, but the analyzer has no notion of the call site that will run an
expression.

An expression kept in a `const` and evaluated elsewhere can declare the type it
runs against, which is what makes it checkable — the checkers see the literal but
not the call that will run it:

```ts
const VISIBLE_MEDICATION = fhirpath("(status in ('entered-in-error' | 'draft')).not()", 'MedicationRequest')
const WEIGHT_KG = compile("value.ofType(Quantity).toQuantity('kg').value", 'Observation') // number[]

fp.test(request, VISIBLE_MEDICATION)
```

The declared type does three things: a relative path infers like a DTO column
(`number[]` above, rather than degrading to `unknown[]`), the expression's input
type becomes that resource instead of one guessed from the path, and the ESLint
rule and `fhirpath-check` analyze the expression against it — so an element typo
in a shared criteria fails the same way it would inside a `@column`. Like a
column's `type`, it is a declaration: nothing checks it at runtime.

A function can also be defined in FHIRPath itself — `expression` instead of
`fn`. The body evaluates as if spliced at the call site: the call's input is
the focus, while `%context` and the environment stay the caller's. This is the
alias mechanism for a chain you keep repeating:

```ts
const functions = {
  displayText: {
    expression: '(text | coding.display.first() | coding.first().code).first()',
    signature: { result: { types: ['System.String'], single: true } },
  },
} satisfies Record<string, CustomFunction>

const fp = new FhirPathEngine({ model: r4Model, functions })
fp.first('Condition.code.displayText()', condition, { type: 'string' })
fp.first('MedicationRequest.medication.ofType(CodeableConcept).displayText()', request, { type: 'string' })
```

Expression-defined functions take zero arguments and keep values typed
end-to-end — a body yielding a dateTime compares as one, with none of the
unwrap-to-JS flattening a native `fn` implies. A body that reaches itself,
directly or through another definition, fails as recursion. The analyzer
resolves them at arity 0 from the same record. An engine pre-parses bodies
through its parse cache; pass a `CompiledExpression` body to get the same
effect with the free `evaluate()`.

### DTOs

A DTO is a class: `defineDto(fhirType)` fixes the resource or datatype its
columns read, and each `@column` field declares one column — the expression on
the decorator, the column's type on the field below it. `fhirType` is the
context every path infers against, so paths stay relative, and **the field's
declared type is checked against what its expression yields**:

```ts
class WeightRow extends defineDto('Observation') {
  @column("value.ofType(Quantity).toQuantity('[lb_av]').value", { default: 0 })
  lbs!: number

  @column('(effective.ofType(dateTime) | issued).first()', { as: 'Date' })
  at!: Date | undefined

  @criteria("status = 'final'")
  isFinal!: boolean

  get rounded(): number {
    return Math.round(this.lbs)
  }
}
const rows = fp.project(observations, WeightRow) // WeightRow[], getters and methods included
```

Declare a type the column cannot hold and the checker names both sides on the
offending decorator:

```ts
@column('clinicalStatus.coding.first().code')
statusCode!: number
//        ^ Decorator function return type 'ColumnTypeMismatch<number, string | undefined>'
//          is not assignable to type 'void | ((this: ProblemRow, value: number) => number)'
```

`@column` takes the same options as a `project()` column — `type`, `as`,
`choices`/`pick`, `enum`, `default`, `collection` — and `@criteria` declares a
boolean criteria column (spec §4.5 semantics: empty → false). Rows are real
instances, so anything derived from the columns belongs on the class as a getter
or method rather than in a column shaper.

**Decorators need a build step.** They are TC39 standard decorators, so the
consuming build must lower them: `tsc` (with `target` ES2024 or lower — at
`esnext` it emits them untouched), swc, or Babel. esbuild, oxc, and
`node --experimental-strip-types` do not support them; this repo's own vitest
config carries a small tsc transform for exactly that reason. Without a
decorator-capable build, `project(input, { … })` with a plain columns record
still works.

Registering DTOs engine-wide turns every column into an expression-defined
function (named by the field, unique across the engine, analyzer signature
derived from the column's `type`), and merges each DTO's `env` into the engine
env. Only one DTO registers per fhirType — it is *the* engine-wide vocabulary
for that resource:

```ts
class CodeableConceptDto extends defineDto('CodeableConcept') {
  @column('(text | coding.display.first() | coding.first().code).first()')
  displayText!: string | undefined
}

const fp = new FhirPathEngine({ model: r4Model, resourceDtos: [CodeableConceptDto] })
fp.first('Condition.code.displayText()', condition, { type: 'string' })
```

`vars` and `env` travel with the DTO, as the second argument to `defineDto`.
`vars` are not registered — they may reference per-call env, so they apply when
the DTO itself is projected, merged under any per-call `vars`. That keeps join
tables and their bindings inside the DTO:

```ts
class OrderRow extends defineDto('ServiceRequest', {
  vars: { report: '%reports.where(orderId = %context.id).report' },
}) {
  @column('id', { default: '' })
  id!: string

  @column('%report.status', { type: 'string', default: 'waiting' })
  reportStatus!: string
}
fp.project(orders, OrderRow, { env: { reports } })
```

Columns several DTOs share live on a base class — extend it and its columns come
along, so the row key or a badge group is written once:

```ts
class ObservationRow extends defineDto('Observation') {
  @column('(effective.ofType(dateTime) | issued).first()', { as: 'Date' })
  at!: Date | undefined
}
class WeightRow extends ObservationRow { … }
class HeightRow extends ObservationRow { … }
```

For a group shared across *different* resources, make the base a function of the
root — `function keyedRow<Root extends FhirTypeName>(fhirType: Root) { class KeyedRow extends defineDto(fhirType) { … } return KeyedRow }` —
and the columns keep inferring against whatever root each DTO passes.

For a column that yields one of a few known codes, `enum` gives a cast-free
literal-union type and checks it at runtime (a value outside the list becomes
empty, so `default` catches it):

```ts
@column('iif(dosageInstruction.asNeeded.ofType(boolean) = true, …)', {
  enum: ['asNeeded', 'continuous'],
  default: 'continuous',
})
group!: 'asNeeded' | 'continuous'
```

`project()` checks every row's `resourceType` against the DTO's `fhirType` and
throws on a mismatch — without the check, wrong input would come back as
well-typed rows full of defaults. Filter the input first to project a subset; a
subject with no `resourceType` (a datatype value) has nothing to check.

TypeScript checks the declaration shapes and the field types, but never looks
inside the expression strings. `analyzeDto` from `fhirpath-ts/analyzer` closes
that gap — run it in a test next to each DTO:

```ts
import { analyzeDto, analyzeEngineDtos } from 'fhirpath-ts/analyzer'

// The engine carries everything the check needs: its model, the functions its
// registered DTOs contribute, and its env names.
expect(analyzeDto(LabResultRow, { engine: fp })).toEqual([])

// And it knows which DTOs it registered, so the vocabulary needs no list:
expect(analyzeEngineDtos(fp)).toEqual([])
```

Data that arrives per call is the DTO's own declaration, not the checker's
configuration: `callerEnv` names the env the projecting call supplies, so the
expressions reading it are checked instead of reported as undefined.

```ts
class LabResultRow extends defineDto('ServiceRequest', {
  callerEnv: ['reports'], // fp.project(orders, LabResultRow, { env: { reports } })
  vars: { report: '%reports.where(orderId = %context.id).report' },
}) { … }
```

Each finding carries the `member` it came from (a column name, or
`vars.<name>`), the diagnostic code, and the message — so a typo inside an
expression fails CI pointing at the exact column.

`analyzeDto` also cross-checks a column's declared `type` (or `enum`) against
what the analyzer infers the expression yields, which covers the whole language
rather than the inference subset. That is the check for an expression TypeScript
cannot see through — a `&` concatenation, a custom-function call: declare the
column's `type` and a wrong claim becomes a `column-type` finding.

### Parse caching

An engine parses each expression once and keeps it in a private LRU sized by
`cacheSize` (default `DEFAULT_PARSE_CACHE_SIZE`, 500; `0` disables reuse).
Each engine caches independently of other engines and of the free `evaluate()`.
Expressions you `compile()` yourself bypass the cache entirely. `cacheSize` is
read at construction — unlike the other options, passing it per call does nothing.

```ts
const fp = new FhirPathEngine({ model: r4Model, cacheSize: 2000 })
```

Because the cache belongs to the engine, a fresh engine starts cold — keep one
around rather than building one per request. Options that change per request go
in that call's `options`, which override the bound defaults field by field
(`env` and `functions` merge per name instead, so per-request entries sit
alongside the bound ones):

```ts
const fp = new FhirPathEngine({ model: r4Model }) // once, at startup
fp.test(patient, criteria, { env: { requestor }, now: receivedAt }) // per request
```

### Medplum compatibility

`fhirpath-ts/r4` and `@medplum/fhirtypes` are generated from the same HL7 R4
StructureDefinitions, so their types line up closely.

A Medplum resource can be passed straight in, with no cast:

```ts
r4.evaluate('Patient.gender', medplumPatient) // works as-is
```

Fields with a `required` binding to a closed code set are typed as the codes
themselves instead of `string`, taken from the R4 ValueSet and CodeSystem data
at generation time:

```ts
patient.gender // 'male' | 'female' | 'other' | 'unknown'
```

R4 nests narrower codes under broader ones, such as `maiden` under `old` and
`active` under `accepted`. A binding accepts the whole tree, so the nested codes
are included too. Every field that both packages type as a set of codes agrees
code for code, all 429 of them. Bindings to open-ended code systems like MIME
types, and to very large lists like `ResourceType`, stay `string`.

Every field here is optional, including ones the spec marks required, such as
`Observation.status` and `Extension.url`. These types describe shapes to
navigate; checking whether a resource is valid is the analyzer's job. So the two
packages' field types are close without being identical: `Observation['status']`
includes `undefined` here and does not in Medplum's types.

To use Medplum's types for both the input and the result, pass them to
`compile()` or `fhirpath()`:

```ts
import type { HumanName, Patient } from '@medplum/fhirtypes'

const given = compile<'Patient.name', Patient, HumanName[]>('Patient.name')
given.evaluate(medplumPatient, { model: r4Model }) // HumanName[]
```

## Usage recipes

The engine API above is the intended front door for application code. These are
the patterns that come up constantly when building healthcare apps, each one
runnable as shown. `src/api/recipes.test.ts` keeps this section honest: it
exercises every snippet against the engine, and it also reads this section
back — each expression string below must be one the tests run, and must pass
the static analyzer clean — so an edit that lets the README and the tests
drift apart fails the suite. (The join recipe composes its expression from a
fragment at runtime, so its runtime test alone covers it.) To get the same
static checks in your own CI, declare the `%vars` a snippet uses (and
`rowIndex`/`rowTotal` for project columns) via `AnalyzeOptions.variables` / the
ESLint rule's `variables`.

### Display text with fallbacks

FHIR rarely guarantees which field carries the human-readable text. A union
tries alternatives in order (left wins), `first()` picks the survivor —
FHIRPath's spelling of `a ?? b ?? c`:

```ts
// CodeableConcept: text, else the first coding with a display, else a code.
r4.first('Condition.code.select(text | coding.display.first() | coding.first().code).first()', condition, {
  type: 'string',
})

// A patient's display name: prefer the official name, build "Given Family".
r4.first(
  "(Patient.name.where(use = 'official') | Patient.name).first().select(iif(given.exists(), given.first().combine(family).join(' '), (text | family).first()))",
  patient,
  { type: 'string' }
)
```

A chain you use everywhere deserves a name: bind it as an expression-defined
function (see Custom functions) and every CodeableConcept can call it —

```ts
const fp = new FhirPathEngine({
  model: r4Model,
  functions: { displayText: { expression: '(text | coding.display.first() | coding.first().code).first()' } },
})
fp.first('Condition.code.displayText()', condition, { type: 'string' })
```

### Filter and sort a worklist

`filter()` keeps the matching resources; `sort()` (ballot STU, in the
[CI-build spec](https://build.fhir.org/ig/HL7/FHIRPath/)) orders them — a `-`
prefix on a key sorts descending. Choice elements go by stem (`effective`, not
`effectiveDateTime`):

```ts
const systolic = r4.filter(observations, "Observation.code.coding.exists(system = %loinc and code = '8480-6')", {
  env: { loinc: 'http://loinc.org' },
})
const newestFirst = r4.evaluate('Observation.sort(-(effective.ofType(dateTime) | issued).first())', systolic)
```

### Unit-safe quantities

Quantity literals compare with automatic UCUM conversion for the units the
engine knows (see `src/values/ucum.ts`); unknown units still compare within
themselves. `toQuantity(unit)` converts, `.value` extracts the number, and
`convertsToQuantity(unit)` is the criteria-side check for dirty data:

```ts
r4.filter(observations, "value.ofType(Quantity) > 140 'mm[Hg]'")
r4.filter(observations, "value.ofType(Quantity).convertsToQuantity('kg')") // drops unit: "lbs" with no code
r4.first("Observation.value.ofType(Quantity).toQuantity('kg').value", weight) // number | undefined, inferred
```

### View rows straight from project()

With `%rowIndex` keys, `default` fallbacks, `test` flags, and `as` narrowing, the
column map is the view model — no `.map()` after it. `default` also removes
`undefined` from the column's type, which an in-expression `| 'fallback'`
union cannot do, and it is the only way a column yields `null`:

```ts
const cards: MedicationCard[] = r4.project(requests, {
  id: { path: '(MedicationRequest.id | %rowIndex.toString()).first()', default: '' },
  name: {
    path: '(MedicationRequest.medication.ofType(CodeableConcept).select(text | coding.display.first()) | MedicationRequest.medication.ofType(Reference).display).first()',
    default: 'Medication',
  },
  sig: { path: 'MedicationRequest.dosageInstruction.first().text', default: '' },
  isActive: { test: "MedicationRequest.status = 'active'" },
  prescribedOn: { path: 'MedicationRequest.authoredOn', default: null }, // string | null
})
```

Only declare `type` when inference can't see the expression — `iif`, a `%var`
navigated without a fixed-return tail, or a path built with `+`/template
strings (TypeScript types those `string`, not a literal). A plain literal
path infers on its own, often more precisely (`MedicationRequest.status`
infers the R4 status-code union), and that includes `a | b` unions,
`(…)` groups, and `%var` roots ending in a fixed-return call like
`%rowIndex.toString()`.

### Status labels from code choices

`choices` decodes a code into your display vocabulary in TypeScript — no cast,
no env-table join — the way a Django field's `choices` name the values it may
hold. Give it a display table (rows keyed by `code`) and `pick` the field each
column reads, typed from the row; a miss becomes empty, so `default` doubles as
the fallback for unexpected or future codes:

```ts
const STATUS_CHOICES = [
  { code: 'active', label: 'Active', tone: 'info' },
  { code: 'recurrence', label: 'Recurrence', tone: 'danger' },
  { code: 'resolved', label: 'Resolved', tone: 'neutral' },
] as const
r4.project(conditions, {
  label: { path: 'Condition.clinicalStatus.coding.first().code', choices: STATUS_CHOICES, pick: 'label', default: 'Unknown' },
  tone: { path: 'Condition.clinicalStatus.coding.first().code', choices: STATUS_CHOICES, pick: 'tone', default: 'neutral' as const },
})
```

Omit `pick` to yield the whole matching row, or pass a plain Record
(`choices: { active: 'info', … }`) when there is a single field to decode. When
the fallback is computed rather than constant — say, title-casing the raw code —
a DTO getter reads the code column back off the row (see [DTOs](#dtos)), and a
bare `project()` call can use an `as` function:
`as: code => STATUS_CHOICES.find(row => row.code === code)?.label ?? titleCase(String(code))`.

### Join related resources

A lookup `Map` becomes an env table of `{ key, resource }` pairs, and a `vars`
entry scans it once per row — a correlated left join written in one place
instead of spliced into every column. `%context` is the row's own resource; a
row with no match survives with each column's `default` (pre-filter with
`r4.filter` for inner-join semantics). Resources inside env values are
model-typed by `resourceType`, so choice stems like `effective` work, and the
var keeps that typing for every column that reads it:

```ts
const reports = [...reportsByOrderId].map(([orderId, report]) => ({ orderId, report }))
r4.project(orders, {
  resultDate: { path: '(%report.effective.ofType(dateTime) | %report.issued).first()', type: 'string', default: null },
  hasResult: { test: '%report.exists()' },
}, { env: { reports }, vars: { report: '%reports.where(orderId = %context.id).report' } })
```

### Extensions — including primitive extensions

`extension(url)` filters by URL; the `%ext-` variable family expands to
`http://hl7.org/fhir/StructureDefinition/…`. Extensions on primitives (the
JSON `_field` sibling) navigate transparently:

```ts
r4.first('Patient.extension(%pharmacyUrl).value.ofType(string)', patient, {
  env: { pharmacyUrl: 'http://example.org/fhir/StructureDefinition/preferred-pharmacy' },
})
r4.first('Patient.birthDate.extension(%`ext-patient-birthTime`).value.ofType(dateTime)', patient)
```

### Follow references inside a Bundle

`resolve()` follows a Reference to a contained resource or another Bundle
entry (by `fullUrl` or `ResourceType/id`). Root the expression at `Bundle` —
that keeps the bundle as the resolution scope:

```ts
r4.evaluate('Bundle.entry.resource.ofType(Observation).subject.resolve().name.family', searchset)
```

### Walk nested structures

`repeat()` closes over a recursive element — every `linkId` of a nested
Questionnaire, in document order:

```ts
r4.evaluate('Questionnaire.repeat(item).linkId', questionnaire)
```

### Deterministic tests and debugging

`now` pins the evaluation clock, so `today()`/`now()` comparisons are
reproducible; `trace()` reports through the `trace` sink instead of logging
(traced values may contain patient data — nothing is logged by default):

```ts
r4.test(patient, 'birthDate <= today()', { now: new Date('2026-08-04T12:00:00Z') })
r4.evaluate("Patient.name.trace('names').given", patient, { trace: (name, values) => debugSink(name, values) })
```

### One gotcha worth knowing

**Inside `where()` the focus is the item being scanned.** In
`%table.where(code = DiagnosticReport.status)` the path navigates from the
table row — silently empty, since unknown elements navigate to empty. Start
join paths at `%context` or another `%var`, which resolve independent of
focus.

## Conformance

The official test suites from
[FHIR/fhir-test-cases](https://github.com/FHIR/fhir-test-cases) are vendored,
converted to JSON offline, and run in vitest on every test run:

| Suite | Pass | Skipped (with reasons) | Failing |
| --- | --- | --- | --- |
| R4 (`tests-fhir-r4.xml`) | 923 | 12 | 0 |
| R5 (`tests-fhir-r5.xml`) | 1,026 | 25 | 0 |

**100% of non-skipped cases pass**, and failing cases must fail in the phase
the suite names: `invalid="syntax"` raises `FhirPathSyntaxError` at parse,
`invalid="semantic"` a `FhirPathTypeError`, `invalid="execution"` a runtime or
type error — with the six deliberate divergences documented in a
hygiene-enforced `PHASE_OVERRIDES` list. The static analyzer runs its own
conformance pass over both suites (`src/analyzer/official-conformance.test.ts`):
strict-mode and semantic cases must produce an error diagnostic, and every
valid case must produce none.

Every skip is listed in `test-data/official/skip-manifest.ts` with a reason,
and a hygiene test fails if an entry stops matching. Each category carries its
root cause:

| Skip category | Root cause | Evidence |
| --- | --- | --- |
| Terminology mode (needs a terminology service) | Implementation (deferred feature) | README, deferred features |
| CDA mode (needs a CDA ModelInfo) | Implementation (deferred feature) | README, deferred features |
| Lenient-polymorphics mode | Implementation (profile-dependent behavior not offered) | skip-manifest reasons |
| Strict-mode static-typing cases | By design — enforced by the analyzer's conformance pass instead of the evaluator | `official-conformance.test.ts` |
| R5-only elements (`DiagnosticReport.composition`, `ConceptMap.target.relationship`) | Implementation (this package ships the R4 model) | skip-manifest reasons |
| `LowBoundary`/`HighBoundary` decimal-15/16 and DateTime-millisecond cases | Test bug — the suite's expected boundaries contradict the mathematical bounds (worth filing upstream at [fhir-test-cases](https://github.com/FHIR/fhir-test-cases/issues)) | reasons in `skip-manifest.ts` |
| `testIif6` (R4), `testPlusDate19` (R4) | Spec ambiguity — R5 revised the R4 behavior; this engine follows R5 | skip-manifest reasons |

Two guards watch the suites themselves:

- **Property + differential fuzzing** (none of the reference engines studied
  have any): printer/parser round-trip over generated ASTs
  (`src/parser/roundtrip-fuzz.test.ts`), exact-decimal arithmetic laws and
  temporal comparison laws (`src/values/*-properties.test.ts`), and generated
  expressions evaluated against both this engine and
  [fhirpath.js](https://github.com/HL7/fhirpath.js) over the official patient
  fixture (`src/testing/differential-fuzz.test.ts`).
- **Upstream drift watch** (`.github/workflows/drift-watch.yml`): a weekly,
  report-only job re-converts the suites from `FHIR/fhir-test-cases@master`
  and fails when new or changed cases appear, with the diff as an artifact.

The reference implementations' own corpora run too (`src/fhirpathjs.test.ts`):

| Corpus | Pass | Skipped (with reasons) |
| --- | --- | --- |
| [HL7/fhirpath.js](https://github.com/HL7/fhirpath.js) `test/cases` + [fhirpath-py](https://github.com/beda-software/fhirpath-py) extras | 2,289 | 1,380 |

Skips are non-R4 models (1,078 — mostly `model: r5`), cases disabled upstream, and
241 **documented intentional divergences** in `test-data/fhirpathjs/quirk-manifest.ts`
— places where the reference behavior contradicts the spec text or the official
suites (their whitespace-trimming `~`, month = 30 days, flags argument on
`matches()`, …). Each manifest family carries its evidence, and hygiene tests keep
it exact. [octofhir/fhirpath-rs](https://github.com/octofhir/fhirpath-rs) was
reviewed as well: its corpus is a regrouped official R5 suite plus custom cases
ported into `src/reference-crosschecks.test.ts` (alongside Medplum spot checks).

## Static checking (official spec §11)

Three layers, from cheapest to most thorough:

1. **Type-level inference** (`tsc`, zero infrastructure) for the tractable subset:
   dotted paths, `[n]`, the type-preserving identity functions
   (`where()/first()/last()/single()/distinct()/tail()/skip()/take()/exclude()/intersect()/trace()`),
   `select()` sub-paths, `ofType()/as()`, the fixed-return family —
   existence/comparison booleans (`exists()/empty()/not()/matches()/startsWith()`, …),
   `count()/length()/indexOf()` and the other integer/decimal results, the
   `toX()`/`convertsToX()` conversions, and the string functions
   (`join()`, `trim()`, `replace()`, `substring()`, `split()`, …) — choice
   stems, `a | b` unions and `(…)` groups of inferable terms, and `%var`
   roots (which stay `unknown[]` unless a fixed-return call ends the chain).
   Anything else degrades to `unknown[]` — never a type error.
2. **ESLint rule** (`fhirpath-ts/eslint`) — runs the analyzer as a lint rule over
   every literal expression at each API entry point: the `` fhirpath`...` `` tag,
   the expression-first calls (`fhirpath()`, `compile()`, `evaluate()`,
   `evaluateTyped()`, `first()`, `analyzeExpression()`), the subject-first
   `FhirPathEngine` helpers (`test()`, `filter()`, `project()` column expressions,
   `checkConstraints()` constraint expressions), and DTO declarations —
   `@column`/`@criteria` fields and a `defineDto()` `vars`. This repo dogfoods it, so
   `pnpm lint` — locally, on pre-commit, and in CI — statically checks the
   library's own expressions alongside the ordinary JS/TS rules:

   ```js
   import fhirpathPlugin from 'fhirpath-ts/eslint'
   export default [
     { plugins: { fhirpath: fhirpathPlugin }, rules: { 'fhirpath/no-invalid-expressions': 'error' } },
   ]
   ```

   By default only the API imported from `fhirpath-ts` (or used bare) is checked.
   The rule takes options to widen that: `packages` adds import-source prefixes to
   treat as the FHIRPath API, and `localImports: true` also treats relative imports
   as the API — which is how this repo dogfoods the rule on its own relatively-imported
   source (see `eslint.config.ts`).

   A DTO field is analyzed against its class's `fhirType`, read from the class's
   `extends defineDto('…')` clause, so relative column paths are checked the same
   way `analyzeDto` checks them. Each `@column` field also *declares* a
   zero-argument function named by the field — what registering the DTO does at
   runtime — so calls between a file's own columns resolve, carry their declared
   result type into the calling expression (`code.displayText() + 1` is an
   operand-type error), and stop being reported at ordinary call sites.

   Where a source walker cannot know the whole picture it stays quiet rather than
   guessing: a column's `%vars` may come from a base class or the projecting call,
   so they are not judged; a call into a DTO that lives in *another* module is
   invisible here, so an unresolved function is reported only when it plausibly
   misspells a column the same file declares (`code.displayTxt()` next to a
   `displayText` column); and a class extending a base class or a root-generic
   factory — no statically-known `fhirType` — is checked for syntax only, since a
   relative path with a leading `code`/`text` segment would otherwise be misread
   as a type-name root. For cross-module DTO vocabularies, list the column names
   in the rule's `functions` option; `analyzeDto` in a test is the complete check
   either way, since it sees the engine's real function set.

   The common-name helpers (`test`, `filter`, `first`, `project`) fire only on
   receivers the file binds to this package — an import like `r4`, or a
   `new FhirPathEngine(...)` local — so other libraries' `.filter()`/`.first()`
   calls are never analyzed as FHIRPath. A trusted name the file also re-binds
   (a `function query(r4)` parameter) loses that trust for the whole file, favoring
   silence over false positives. The flip side: an engine reached through an
   untracked alias (`this.engine`, a function parameter) is not statically checked.
   The DTO vocabulary (`column`, `criteria`, `defineDto`) goes further: those names
   are checked only when the file imports them from the package, so another
   library's `column('id')` is never read as FHIRPath.

3. **`fhirpath-check` CLI** — the same analyzer (and the same call-site policy) as a
   standalone command, for repos that do not lint with ESLint (e.g. Biome repos, whose
   GritQL plugins cannot execute the analyzer). It needs `typescript` installed (an
   optional peer dependency — the compiler both parses your files and loads your DTO
   modules). It does two things:

   ```sh
   # Every expression literal in the given files, read from source.
   pnpm exec fhirpath-check "src/**/*.ts"

   # Plus every DTO in the project's *.dto.ts modules, imported and checked
   # against the engine that projects it. This half needs no arguments.
   pnpm exec fhirpath-check
   ```

   The second half is the one a source walker cannot do. DTO modules are
   *imported*, so `analyzeDto` runs with the real thing: calls between columns
   resolve through the engine's registered DTOs, `vars` and `env` are known, and a
   declared column `type` is cross-checked against the analyzer's own inference.
   Findings carry the class, the member and a source position:

   ```
   src/fhir/patient.dto.ts:18:42 ProblemRow.statusCode [unknown-element] Element 'codee' is not defined on FHIR.Coding — did you mean 'code'?
   fhirpath-check: analyzed 13 DTO(s) from 1 module(s) against 1 engine(s)
   ```

   Discovery needs no configuration, which is why the convention matters:

   - **DTOs live in `*.dto.ts`.** That is the default glob; `--dtos "<glob>"`
     (repeatable) points elsewhere.
   - **Export the DTO classes** you want checked — the checker reads a module's
     exports. Engines need no export: constructions are recorded, so a
     module-private `const fp = new FhirPathEngine(…)` is still found.
   - Put the engine where the DTOs are (the same `*.dto.ts` file is fine) or point
     `--dtos` at both. Without an engine in reach, column-to-column calls cannot
     resolve, and the CLI says so instead of failing the run.
   - `--no-import` skips this half entirely, for a source-only pass.

   It exits non-zero on any error-severity diagnostic, so both halves drop into CI
   and pre-commit as they are:

   ```yaml
   # .github/workflows/ci.yml
   - run: pnpm exec fhirpath-check "src/**/*.ts"   # source literals + the DTO sweep
   ```

   ```json
   // package.json — with lint-staged, on pre-commit
   { "lint-staged": { "*.ts": ["fhirpath-check --no-import"] } }
   ```

   A pre-commit hook usually wants `--no-import` on the staged files (fast, no
   module side effects), with the DTO sweep in CI where importing is fine. This
   repo does exactly that: the ESLint rule covers the source half on every commit,
   and `pnpm check:fhirpath` runs the sweep in CI.

Both read the same call-site policy (`src/analyzer/expression-policy.ts`) and
analyze each site through the same `analyzeSite`, so they agree on what counts as
an expression and on what a site's context is. The rule walks ESLint's AST;
everything else — the CLI, the demo playground's editor markers, a bundler
plugin — extracts sites with `fhirpath-ts/sites`, which walks the real
TypeScript AST. Its `createSiteFinder(ts)` takes the compiler as an argument
rather than importing it, so the package itself stays dependency-free and each
caller supplies the TypeScript it already has: the CLI uses the `typescript`
package (an optional peer dependency), and the demo hands in the copy Monaco
ships inside its worker — extraction runs there, off the main thread, and no one
bundles a second compiler.

The analyzer (`fhirpath-ts/analyzer`, `analyzeExpression(expr, { model, inputType })`)
implements the spec's strict-mode rules: singleton misuse on inputs, operands and
arguments; wrong operand/argument types; equality that can never hold; unknown
elements (including choice-key misuse like `Observation.valueQuantity`), functions,
arities, and type names. Unknown regions (`children()`, `descendants()`, `resolve()`,
`%vars`) mute checks until narrowed with `as`/`ofType()`, exactly as §11 prescribes.

## Architecture

- Hand-written lexer and Pratt parser over a plain discriminated-union AST with
  source spans; a canonical printer round-trips every official-suite expression.
  Hand-written beats ANTLR generation here for four reasons: no runtime dependency
  (the ANTLR runtime is what fhirpath.js/fhirpath-py ship), no codegen build step
  (this repo consumes packages from source), full control over error positions and
  hostile-input bounds (the 500-level depth cap; generated parsers recurse
  unboundedly), and speed (~2µs parses). The grammar is small and frozen (13
  precedence levels), so the usual ANTLR advantage — tracking a moving grammar —
  does not apply; the normative `fhirpath.g4` stays the source of truth for tests.
  The Pratt structure is adapted from
  [Medplum](https://github.com/medplum/medplum)'s parser (Apache-2.0).
- Exact decimal arithmetic on a BigInt-scaled `Decimal` (no float drift:
  `0.1 + 0.2 = 0.3` holds), partial-precision `Temporal` date/time values, and a
  built-in UCUM subset with exact conversion factors (`1 'm' = 100 'cm'`).
  "Exact-factor subset" means a curated table (SI prefixes × base units plus the
  customary units the official suites exercise) whose factors are exact decimal
  strings — conversions carry zero rounding error, where `@lhncbc/ucum-lhc` (used
  by fhirpath.js) covers all ~300 UCUM units in float arithmetic. What the subset
  omits: offset units (`Cel`, `[degF]`), logarithmic/special units (`B`, `Np`),
  and arbitrary units. Units outside the table still work as opaque units that
  compare with themselves; only cross-unit conversion needs the table.
- The engine core is model-agnostic behind a `ModelProvider` interface (the spec's
  ModelInfo concept). `scripts/generate-r4-model.ts` generates the R4 model from the
  HL7 StructureDefinitions in `@medplum/definitions` — runtime tables and the
  type-level maps come from the same generator run, so they cannot drift apart.

## Coverage

Enforced vitest thresholds: 99% statements / 96% branches / 99.5% functions / 99%
lines (current: 99.4 / 96.5 / 99.8 / 99.3). The uncovered remainder is annotated
`v8 ignore` defensive guards (exhaustiveness defaults, impossible states) and
fallback halves of `??`-style guards on shapes real FHIR data does not produce.

## Gaps and deferred features

Current limitations beyond the deferred features below: the R4 model is the only
one shipped (`model: r5/stu3/dstu2` reference-corpus cases are skipped); the
engine is synchronous by design; regex evaluation of **user-authored** expressions
is the one unhardened dimension (see Security); and tagged templates stay untyped
(TS#33304) — use the `fhirpath('...')`/`compile('...')` call forms for inference.
Behavioral differences from the reference implementations are not gaps but
documented choices: see the divergence manifest under Conformance.

Deferred features — planned but deliberately out of v1; each fails with a clear
error today:

| Feature | Why deferred | Unblocks it |
| --- | --- | --- |
| `memberOf()`, `subsumes()`, `subsumedBy()`, `%terminologies` | Need a terminology service | A pluggable async `TerminologyProvider` + `evaluateAsync()` |
| `resolve()` of external references | Sync engine; only Bundle/contained resolve today | Same async path |
| `conformsTo()` beyond base StructureDefinitions | Needs a FHIR profile validator | Profile-aware validation layer |
| `slice()`, `elementDefinition()`, `checkModifiers()` | Need profile definitions (the reference implementation skips these too) | Profile-aware ModelProvider |
| `weight()` | Needs code-system itemWeight lookups | Terminology provider |
| `%factory` type-factory API | R5 draft, maturity 0 | Demand |
| CDA mode | Different data model | A CDA ModelProvider (the interface already allows it) |
| Full UCUM | The built-in subset covers the official suites | Swap `values/ucum.ts` internals for `@lhncbc/ucum-lhc` |
| R5 model package | This repo runs R4 (Medplum) | Re-run the generator against R5 definitions |

## Security

**Expression trust boundary.** The engine is hardened against hostile *expressions*
in most dimensions — parser nesting is capped, tokenization is linear, UCUM
exponents and decimal exponents are bounded, and navigation never reads the
prototype chain — with one documented exception: by default `matches()`,
`matchesFull()`, and `replaceMatches()` compile their pattern argument with the
host `RegExp`, so a catastrophic-backtracking pattern like `(a+)+$` can stall the
event loop (a true regex timeout is impractical without native dependencies).
This is fine when expressions are developer-authored (the normal case). Two
guards cover the rest:

- **Static detection.** The analyzer (and therefore the ESLint rule and the
  `fhirpath-check` CLI) emits a `regex-backtracking` warning when a literal
  pattern nests unbounded repetition — the exponential shape — so
  developer-authored patterns get caught in review.
- **Pluggable engine.** If a deployment evaluates **user-authored** FHIRPath —
  SDC `enableWhen`, Questionnaire logic, stored expressions — supply a
  linear-time regex engine (e.g. an RE2 binding) via `EvaluateOptions.regex`;
  the zero-dependency default stays untouched. Vet or sandbox such expressions
  regardless.

**Narrative checking.** `htmlChecks()` validates against FHIR's narrative rules
with an inert-URL-scheme allowlist, entity-decoding attribute values the way a
browser would. A `true` result means the narrative carries no active content.

**PHI note.** `trace()` is a no-op unless you pass a `trace` sink. Traced values
may contain patient data — do not point the sink at console output or log files in
production (org policy: never log PHI values; use record ids instead).

## Licensing and attribution

Package code is part of this repository (private). All third-party material it
contains is consolidated with full license texts in
[`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md) — ship that file with any
future redistribution (npm, OSS extraction). In short:

- Parser structure adapted from Medplum (Apache-2.0) — see `src/parser/parser.ts`.
- Official FHIRPath test suites from FHIR/fhir-test-cases (Apache-2.0 / FHIR CC0
  content) — `test-data/official/`, license alongside.
- Reference test corpora from HL7/fhirpath.js (NLM BSD-style) and
  beda-software/fhirpath-py (MIT) — `test-data/fhirpathjs/`, licenses alongside.
- Custom test cases from octofhir/fhirpath-rs (Apache-2.0) and Medplum spot checks
  — `src/reference-crosschecks.test.ts`.
- R4 model data generated from the HL7 FHIR R4 StructureDefinitions (CC0) shipped in
  `@medplum/definitions`. FHIR® is a registered trademark of HL7.

## Development

```bash
pnpm test        # full suite incl. official conformance
pnpm coverage    # with enforced thresholds
pnpm typecheck
pnpm generate:r4 # regenerate model data (offline)
node packages/fhirpath/scripts/bench.ts      # parse/eval micro-benchmarks
```

Regenerate `test-data/official/*/tests.json` with
`node scripts/convert-official-tests.ts` after refreshing the vendored XML.
