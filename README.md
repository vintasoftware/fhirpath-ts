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

| | **fhirpath-ts** | fhirpath.js | fhirpath-py | fhirpath-rs | Medplum |
|---|---|---|---|---|---|
| Runtime deps | zero | ANTLR runtime, ucum-lhc, … | ANTLR runtime | Rust crates | none (large SDK) |
| Decimal arithmetic | exact, always on | floats (opt-in precise mode) | Python decimal | Rust decimal | floats |
| Official R4+R5 suites in CI | 100% of non-skipped | not run | not run | regrouped R5 | not run |
| Runs the other engines' suites | yes, with evidence for each divergence | no | no | no | no |
| Compile-time result types | yes (plain `tsc`) | no | no | no | no |
| Spec §11 as dev tooling | CLI + ESLint + API | no | no | runtime analyzer | no |
| Terminology / async / `%factory` | deferred (see Gaps) | yes | partial | `%factory` | no |
| FHIR models | R4 (provider interface) | DSTU2–R5 | DSTU2–R5 | R5 | R4 |

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

Beyond the JS-ecosystem table above, the correctness work studied the strongest
implementations in the field — HAPI (the HL7 Java reference engine),
[helios-fhirpath](https://github.com/HeliosSoftware/hfs) (Rust),
[kotlin-fhirpath](https://github.com/ohs-foundation/kotlin-fhirpath) (Kotlin
Multiplatform), and the analyzer behind
[HealthSamurai's fhirpath-editor](https://github.com/HealthSamurai/fhirpath-editor)
— and adopted each practice that survived scrutiny:

| Practice | **fhirpath-ts** | HAPI / HL7 Java | helios-fhirpath | kotlin-fhirpath | HealthSamurai editor |
|---|---|---|---|---|---|
| Official suites in CI | R4 + R5, 100% of non-skipped | R4/R5 | R4 + R5, zero-failure | R4 only (6-platform matrix) | none |
| Failures land in the tagged phase | yes, with documented overrides | yes (the practice's origin) | no | no | — |
| Static type checking (spec §11) | analyzer + CLI + ESLint rule | `check()` API | inference, display-only | none | editor inference |
| Static checker tested against the suites | yes, both directions | via phase assertions | no | — | no (curated units only) |
| Custom functions visible to static checking | yes (one record for both) | yes (resolve/check/execute) | no | no | n/a |
| `resolve()` typed from targetProfile | yes | yes | no | no | `resolve()` absent |
| Exact decimals | BigInt mantissa + scale | BigDecimal | loses trailing zeros (documented) | precision 15, open TODO | n/a |
| Property + differential fuzzing | round-trips, value laws, vs fhirpath.js | none | none | none | none |
| Upstream suite drift watch | weekly re-convert + diff | no | releases blocked on upstream master | no | no |
| Skips documented with root causes | hygiene-checked manifests + README classes | — | reason-annotated failure list | skip registry + README table | n/a |
| ReDoS on `matches()` | static warning + pluggable engine | 500 ms regex timeout | none | none | n/a |

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
by field:

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
  name: { path: "Patient.name.given.join(' ')", type: 'string' },  // string | undefined
})
r4.project(searchset, { id: 'Patient.id' }) // arrays and Bundles: one row per resource
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

`new FhirPathEngine(defaults)` and every evaluate-family call's trailing
`options` argument accept the same fields (per-call wins):

| Option | Meaning |
| --- | --- |
| `model` | A `ModelProvider`; use `r4Model` from `fhirpath-ts/r4` |
| `env` | Environment variables: `{ myVar: 5 }` resolves `%myVar` |
| `now` | Evaluation clock for `now()`/`today()`/`timeOfDay()` (deterministic tests) |
| `trace` | Sink for `trace()` calls — see the PHI note below |
| `functions` | Host-supplied functions — see Custom functions below |

`evaluateTyped(...)` (on the engine, bound expressions, and compiled expressions)
returns the internal `TypedValue[]` (type names plus `Decimal`/`Temporal` value
objects) instead of unwrapped JS values.

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
them instead of flagging `unknown-variable`.

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
   dotted paths, `[n]`, `first()/last()/single()`, type-preserving `where()`,
   `select()` sub-paths, `ofType()/as()`, `exists()/empty()/count()`, choice stems.
   Anything else degrades to `unknown[]` — never a type error.
2. **ESLint rule** (`fhirpath-ts/eslint`) — runs the analyzer as a lint rule over
   every literal expression at each API entry point: the `` fhirpath`...` `` tag,
   the expression-first calls (`fhirpath()`, `compile()`, `evaluate()`,
   `evaluateTyped()`, `first()`, `analyzeExpression()`) and the subject-first
   `FhirPathEngine` helpers (`test()`, `filter()`, `project()` column expressions,
   `checkConstraints()` constraint expressions). This repo dogfoods it, so
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

   The common-name helpers (`test`, `filter`, `first`, `project`) fire only on
   receivers the file binds to this package — an import like `r4`, or a
   `new FhirPathEngine(...)` local — so other libraries' `.filter()`/`.first()`
   calls are never analyzed as FHIRPath. A trusted name the file also re-binds
   (a `function query(r4)` parameter) loses that trust for the whole file, favoring
   silence over false positives. The flip side: an engine reached through an
   untracked alias (`this.engine`, a function parameter) is not statically checked.

3. **`fhirpath-check` CLI** — the same analyzer (and the same call-site policy) as a
   standalone command, for repos that do not lint with ESLint (e.g. Biome repos, whose
   GritQL plugins cannot execute the analyzer): `pnpm exec fhirpath-check src/**/*.ts`.
   It exits non-zero on the first diagnostic, so it drops into any CI or pre-commit hook.

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
