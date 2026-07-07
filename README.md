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
| Terminology / async / `%factory` | pluggable provider + `evaluateAsync()` (`%factory` deferred) | yes | partial | `%factory` | no |
| FHIR models | R4 (provider interface) | DSTU2–R5 | DSTU2–R5 | R5 | R4 |

Three things are genuinely different here. **Expressions are checked before they
run**: the spec has had §11 for years, but the reference engines treat it as at most
a runtime mode — here a typo like `Observation.valueQuantity` or a singleton misuse
is a build failure (type inference in `tsc`, the `fhirpath-check` CLI, or the ESLint
rule), not a production empty-result. **Correctness is demonstrated against everyone
else's tests, not just ours**: 100% of the non-skipped official suites plus the
fhirpath.js/fhirpath-py corpora, with every intentional divergence carrying its
spec citation — a process that caught reference-implementation bugs this engine
refused to inherit (Medplum's `(0).not() = true` contradicts the official suite;
fhirpath.js treats `1 month = 30 days` as true). **The engineering shape fits this
repo**: zero dependencies, source-consumed, hardened against hostile expressions,
and model-agnostic behind a provider interface so R5/CDA are additive. The
trade-offs live in [Gaps and deferred features](#gaps-and-deferred-features).

## Quick start

```ts
import { evaluate, compile, fhirpath } from 'fhirpath-ts'
import { r4Model } from 'fhirpath-ts/r4'

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
(`Observation.value`), primitive `_field` extensions, and type checks
(`is`/`as`/`ofType`). Unknown elements navigate to empty like the reference engines
(typos are the static analyzer's job); the one runtime semantic error is choice-key
misuse (`Observation.valueQuantity`). Without a model the engine navigates raw JSON.

### Options

`evaluate(expr, input, options)` / `compiled.evaluate(input, options)` accept:

| Option | Meaning |
| --- | --- |
| `model` | A `ModelProvider`; use `r4Model` from `fhirpath-ts/r4` |
| `env` | Environment variables: `{ myVar: 5 }` resolves `%myVar` |
| `now` | Evaluation clock for `now()`/`today()`/`timeOfDay()` (deterministic tests) |
| `trace` | Sink for `trace()` calls — see the PHI note below |
| `terminology` | A `TerminologyProvider` for `memberOf()`, `subsumes()`/`subsumedBy()`, `weight()`, and the `%terminologies` API — see Terminology below |

`compiled.evaluateTyped(...)` returns the internal `TypedValue[]` (type names plus
`Decimal`/`Temporal` value objects) instead of unwrapped JS values.

### Terminology

Terminology answers live on a server, so the terminology functions are async:
use `evaluateAsync(expr, input, options)` / `compiled.evaluateAsync(...)`
(`evaluateTypedAsync` for typed results) and pass a `TerminologyProvider` —
an object mirroring the spec's
[terminology service API](https://hl7.org/fhir/fhirpath.html#txapi) with only
the methods you need (`validateVS`, `validateCS`, `subsumes`, `expand`,
`lookup`, `translate`), each returning a promise of the plain JSON resource:

```ts
const terminology: TerminologyProvider = {
  async validateVS(valueSet, coded) {
    const response = await fetch(`${TX_SERVER}/ValueSet/$validate-code?...`)
    return response.json() // a Parameters resource
  },
}
await evaluateAsync("code.memberOf('http://hl7.org/fhir/ValueSet/observation-vitalsignresult')",
  observation, { model: r4Model, terminology }) // [true]
await evaluateAsync('%terminologies.expand(%vs)', ..., { terminology, env: { vs } })
```

This unlocks `memberOf()` (via `validateVS`), `subsumes()`/`subsumedBy()` (via
`subsumes`), `weight()` (itemWeight/ordinalValue extensions answer synchronously;
otherwise a CodeSystem `$lookup` of the `itemWeight` property), and the
`%terminologies` API (`validateVS`, `validateCS`, `subsumes`, `expand`, `lookup`,
`translate`). A provider answer the engine cannot interpret — an unknown value
set, a `Parameters` without a boolean `result` — yields empty, the spec's
"cannot determine" outcome. Under the sync `evaluate()` these functions fail
with a pointer to `evaluateAsync()`. The official R5 terminology tests run
through this exact machinery against recorded tx.fhir.org responses (see
Conformance).

The engine core stays synchronous: `evaluateAsync()` runs it, and when a
function needs a provider answer the evaluation suspends, awaits it, and
replays with the answer cached (so a provider is asked exactly once per
distinct request, and `trace`/`now()` behave as if the evaluation ran once).
Replays re-run the expression itself, so terminology calls cost one extra
evaluation pass each — negligible next to the network round-trip they cache.

## Conformance

The official test suites from
[FHIR/fhir-test-cases](https://github.com/FHIR/fhir-test-cases) are vendored,
converted to JSON offline, and run in vitest on every test run:

| Suite | Pass | Skipped (with reasons) | Failing |
| --- | --- | --- | --- |
| R4 (`tests-fhir-r4.xml`) | 923 | 12 | 0 |
| R5 (`tests-fhir-r5.xml`) | 1,029 | 22 | 0 |

**100% of non-skipped cases pass.** The terminology-mode cases run against
recorded [tx.fhir.org](https://tx.fhir.org) responses
(`test-data/official/r5/tx-fixtures.json`, committed so the suite stays
offline; `pnpm record:tx` re-records them from the live server). Every skip is
listed in `test-data/official/skip-manifest.ts` with a reason, and a hygiene
test fails if an entry stops matching. Skip categories: CDA mode (needs a CDA
model), lenient-polymorphics mode, strict-mode static-typing cases (enforced by
the analyzer instead of the evaluator), R5-only elements (this package ships
the R4 model), and four documented suite oddities.

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
2. **`fhirpath-check` CLI** — scans sources for `` fhirpath`...` `` tags and literal
   `fhirpath()/compile()/evaluate()` arguments, and runs the analyzer over each with
   the R4 model: `pnpm exec fhirpath-check src/**/*.ts`.
   There is no Biome rule because Biome cannot run one: its plugin system is
   GritQL pattern matching and cannot execute the analyzer. The CLI is the
   equivalent CI hook for Biome repos like this one (`check:fhirpath` script).
3. **ESLint rule** for repos that lint with ESLint:

   ```js
   import fhirpathPlugin from 'fhirpath-ts/eslint'
   export default [
     { plugins: { fhirpath: fhirpathPlugin }, rules: { 'fhirpath/no-invalid-expressions': 'error' } },
   ]
   ```

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
engine core is synchronous by design (`evaluateAsync()` wraps it for the
terminology functions); regex evaluation of **user-authored** expressions
is the one unhardened dimension (see Security); and tagged templates stay untyped
(TS#33304) — use the `fhirpath('...')`/`compile('...')` call forms for inference.
Behavioral differences from the reference implementations are not gaps but
documented choices: see the divergence manifest under Conformance.

Deferred features — planned but deliberately out of v1; each fails with a clear
error today:

| Feature | Why deferred | Unblocks it |
| --- | --- | --- |
| `resolve()` of external references | Only Bundle/contained resolve today | The `evaluateAsync()` path that now powers terminology, plus a pluggable resolver |
| `conformsTo()` beyond base StructureDefinitions | Needs a FHIR profile validator | Profile-aware validation layer |
| `slice()`, `elementDefinition()`, `checkModifiers()` | Need profile definitions (the reference implementation skips these too) | Profile-aware ModelProvider |
| Questionnaire answerOption `weight()` | The ordinal lives on the source Questionnaire, not the answer — `weight()` covers extensions and CodeSystem lookups today | SDC-aware questionnaire context |
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
