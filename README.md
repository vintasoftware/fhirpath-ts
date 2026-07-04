# @vinta-bb/fhirpath

A TypeScript-native [FHIRPath](https://hl7.org/fhirpath/) engine with zero runtime
dependencies, verified against the official HL7 conformance suites, plus two things no
other implementation offers together:

- **Compile-time result types** for common expressions, in plain `tsc` with no plugin:
  `compile('Patient.name.given').evaluate(patient)` is a `string[]`.
- **A spec §11 static analyzer** that checks full expressions (unknown elements, wrong
  types, singleton misuse) at CI time, via a CLI or an ESLint rule.

## Quick start

```ts
import { evaluate, compile, fhirpath } from '@vinta-bb/fhirpath'
import { r4Model } from '@vinta-bb/fhirpath/r4'

// One-off evaluation (LRU-cached parse), untyped results:
evaluate('Patient.name.given', patient, { model: r4Model }) // unknown[]

// Compile once, reuse; literal expressions infer result and input types:
const given = compile('Patient.name.given')
given.evaluate(patient, { model: r4Model }) // string[] — and `patient` must be a Patient

// The fhirpath() call form is equivalent; the tag form works but stays untyped
// because TypeScript cannot carry literal types through tagged templates (TS#33304):
fhirpath('Patient.name.given').evaluate(patient, { model: r4Model }) // string[]
fhirpath`Patient.name.given`.evaluate(patient, { model: r4Model }) // unknown[]
```

Pass `{ model: r4Model }` for FHIR-aware evaluation: choice elements by stem name
(`Observation.value`), primitive `_field` extensions, type checks (`is`/`as`/`ofType`),
and strict unknown-element errors. Without a model the engine navigates raw JSON.

### Options

`evaluate(expr, input, options)` / `compiled.evaluate(input, options)` accept:

| Option | Meaning |
| --- | --- |
| `model` | A `ModelProvider`; use `r4Model` from `@vinta-bb/fhirpath/r4` |
| `env` | Environment variables: `{ myVar: 5 }` resolves `%myVar` |
| `now` | Evaluation clock for `now()`/`today()`/`timeOfDay()` (deterministic tests) |
| `trace` | Sink for `trace()` calls — see the PHI note below |

`compiled.evaluateTyped(...)` returns the internal `TypedValue[]` (type names plus
`Decimal`/`Temporal` value objects) instead of unwrapped JS values.

## Conformance

The official test suites from
[FHIR/fhir-test-cases](https://github.com/FHIR/fhir-test-cases) are vendored,
converted to JSON offline, and run in vitest on every test run:

| Suite | Pass | Skipped (with reasons) | Failing |
| --- | --- | --- | --- |
| R4 (`tests-fhir-r4.xml`) | 923 | 12 | 0 |
| R5 (`tests-fhir-r5.xml`) | 1,026 | 25 | 0 |

**100% of non-skipped cases pass.** Every skip is listed in
`test-data/official/skip-manifest.ts` with a reason, and a hygiene test fails if an
entry stops matching. Skip categories: terminology mode (needs a terminology
service), CDA mode (needs a CDA model), lenient-polymorphics mode, strict-mode
static-typing cases (enforced by the analyzer instead of the evaluator), R5-only
elements (this package ships the R4 model), and four documented suite oddities.

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

## Static checking (spec §11)

Three layers, from cheapest to most thorough:

1. **Type-level inference** (`tsc`, zero infrastructure) for the tractable subset:
   dotted paths, `[n]`, `first()/last()/single()`, type-preserving `where()`,
   `select()` sub-paths, `ofType()/as()`, `exists()/empty()/count()`, choice stems.
   Anything else degrades to `unknown[]` — never a type error.
2. **`fhirpath-check` CLI** — scans sources for `` fhirpath`...` `` tags and literal
   `fhirpath()/compile()/evaluate()` arguments, and runs the analyzer over each with
   the R4 model. This is the CI hook for repos (like this one) that lint with Biome:
   `pnpm --filter @vinta-bb/fhirpath exec fhirpath-check src/**/*.ts`
3. **ESLint rule** for repos that lint with ESLint:

   ```js
   import fhirpathPlugin from '@vinta-bb/fhirpath/eslint'
   export default [
     { plugins: { fhirpath: fhirpathPlugin }, rules: { 'fhirpath/no-invalid-expressions': 'error' } },
   ]
   ```

The analyzer (`@vinta-bb/fhirpath/analyzer`, `analyzeExpression(expr, { model, inputType })`)
implements the spec's strict-mode rules: singleton misuse on inputs, operands and
arguments; wrong operand/argument types; equality that can never hold; unknown
elements (including choice-key misuse like `Observation.valueQuantity`), functions,
arities, and type names. Unknown regions (`children()`, `descendants()`, `resolve()`,
`%vars`) mute checks until narrowed with `as`/`ofType()`, exactly as §11 prescribes.

## Architecture

- Hand-written lexer and Pratt parser (no ANTLR runtime) over a plain
  discriminated-union AST with source spans; a canonical printer round-trips every
  official-suite expression. The Pratt structure is adapted from
  [Medplum](https://github.com/medplum/medplum)'s parser (Apache-2.0).
- Exact decimal arithmetic on a BigInt-scaled `Decimal` (no float drift:
  `0.1 + 0.2 = 0.3` holds), partial-precision `Temporal` date/time values, and a
  built-in UCUM subset with exact conversion factors (`1 'm' = 100 'cm'`).
- The engine core is model-agnostic behind a `ModelProvider` interface (the spec's
  ModelInfo concept). `scripts/generate-r4-model.ts` generates the R4 model from the
  HL7 StructureDefinitions in `@medplum/definitions` — runtime tables and the
  type-level maps come from the same generator run, so they cannot drift apart.

## Coverage

Enforced vitest thresholds: 99% statements / 96% branches / 99.5% functions / 99%
lines (current: 99.4 / 96.5 / 99.8 / 99.3). The uncovered remainder is annotated
`v8 ignore` defensive guards (exhaustiveness defaults, impossible states) and
fallback halves of `??`-style guards on shapes real FHIR data does not produce.

## Deferred features

Planned but deliberately out of v1; each fails with a clear error today:

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
prototype chain — with one documented exception: `matches()`, `matchesFull()`, and
`replaceMatches()` compile their pattern argument with the host `RegExp`, so a
catastrophic-backtracking pattern like `(a+)+$` can stall the event loop. This is
fine when expressions are developer-authored (the normal case). If a deployment
evaluates **user-authored** FHIRPath — SDC `enableWhen`, Questionnaire logic,
stored expressions — vet or sandbox those expressions and bound the subject string
length; a true regex timeout is impractical without native dependencies.

**Narrative checking.** `htmlChecks()` validates against FHIR's narrative rules
with an inert-URL-scheme allowlist, entity-decoding attribute values the way a
browser would. A `true` result means the narrative carries no active content.

**PHI note.** `trace()` is a no-op unless you pass a `trace` sink. Traced values
may contain patient data — do not point the sink at console output or log files in
production (org policy: never log PHI values; use record ids instead).

## Licensing and attribution

Package code is part of this repository (private). It contains:

- Parser structure adapted from Medplum (Apache-2.0) — see `src/parser/parser.ts`.
- Official FHIRPath test suites from FHIR/fhir-test-cases (Apache-2.0 / FHIR CC0
  content) — `test-data/official/`, license alongside.
- JSON fixture conversions from HL7/fhirpath.js (NLM public-domain-style license) —
  `test-data/official/FIXTURES-LICENSE.md`.
- R4 model data generated from the HL7 FHIR R4 StructureDefinitions (CC0) shipped in
  `@medplum/definitions`.

## Development

```bash
pnpm --filter @vinta-bb/fhirpath test        # full suite incl. official conformance
pnpm --filter @vinta-bb/fhirpath coverage    # with enforced thresholds
pnpm --filter @vinta-bb/fhirpath typecheck
pnpm --filter @vinta-bb/fhirpath generate:r4 # regenerate model data (offline)
node packages/fhirpath/scripts/bench.ts      # parse/eval micro-benchmarks
```

Regenerate `test-data/official/*/tests.json` with
`node scripts/convert-official-tests.ts` after refreshing the vendored XML.
