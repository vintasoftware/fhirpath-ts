# Correctness guarantees: cross-implementation study and roadmap

## Context

On 2026-07-08 we studied four FHIRPath implementations to find correctness
guarantees they have that fhirpath-ts should adopt — for the library itself
(conformance, provability, testing rigor) and for library usage (APIs and tooling
that prevent user mistakes):

- **kotlin-fhirpath** (`ohs-foundation/kotlin-fhirpath`, Kotlin Multiplatform,
  1.0.0-beta03) — successor to Google's Android FHIR / Open Health Stack work.
- **HAPI / HL7 Java** — `org.hl7.fhir.r5.fhirpath.FHIRPathEngine` in
  `hapifhir/org.hl7.fhir.core` (the reference implementation, authored by Grahame
  Grieve), wrapped by HAPI's `ca.uhn.fhir.fhirpath.IFhirPath`.
- **helios-fhirpath** (`HeliosSoftware/hfs`, Rust, v0.2.1, FHIRPath 3.0.0).
- **HealthSamurai/fhirpath-editor** — the static-type-analysis engine behind their
  "Unlocking FHIRPath Power" article (a structured block editor, not a text engine).

Every claim about our own code below was re-verified against main at `0d838ba`
(post Biome→ESLint migration). Findings are grouped into five workstreams, each
intended as a separate follow-up branch. Open questions are stated, not silently
resolved.

---

## What each implementation contributes (summary)

**kotlin-fhirpath.** Parser is ANTLR-generated from the official FHIRPath 2.0.0
`.g4`, hardened with `BailErrorStrategy` (no error recovery) plus an explicit EOF
check, because ANTLR otherwise accepts a valid prefix and ignores trailing garbage.
Runs the vendored official R4 suite (937 cases) in a CI matrix across 6 platforms,
with a skip registry where every skip has a written reason and a root-cause class
(`Implementation` / `Test` / `Specification`), mirrored into a README conformance
table with links to upstream fhir-test-cases issues and HL7 chat/JIRA threads.
Preserves FHIR primitives (with `id`/`extension`) through traversal, unwrapping to
System values lazily. Weaknesses: decimal precision 15 with a `// TODO: clarify with
the specification` and rounding tied to an open HL7 JIRA (FHIR-53159); no static
analysis; untyped `Collection<Any>` results; only the R4 suite is conformance-tested
despite shipping R4B/R5 engines; no property/fuzz/differential testing; documented
timezone policy (offset-vs-no-offset comparison returns `{}` rather than assuming a
default offset, consciously failing a couple of official tests).

**HAPI / HL7 Java.** The deepest correctness architecture: a three-phase pipeline —
`parse()` → `check()` → `evaluate()` — with distinct error classes per phase, and the
official suite's `invalid="syntax|semantic|execution"` tags asserted to fail *at the
right phase* (`FHIRPathTests.java:181-252`). `check()` walks the expression
propagating `TypeDetails` (a set of candidate `ProfiledType`s + a
`SINGLETON/ORDERED/UNORDERED` collection status + allowed reference `targets` +
value-set bindings) and rejects unknown properties, wrong-context navigation, bad
argument types, and choice-type misuse before any data exists; collection-passed-
where-singleton-expected is a *warning*. Callers include StructureDefinition
invariant validation, SearchParameter validation, and SQL-on-FHIR ViewDefinition
validation. Explicit strictness flags (`allowPolymorphicNames`,
`doNotEnforceAsSingletonRule`, `legacyMode`, …) defaulted per FHIR version, and a
`regexTimeoutMillis = 500` ReDoS guard on `matches()`. Custom functions are a
*triple* via host services — `resolveFunction` (existence + arity, consulted at
parse) / `checkFunction` (static: validates argument `TypeDetails`, returns the
result type) / `executeFunction` — plus paired `resolveConstant`/`resolveConstantType`;
skipping the check leg is what breaks static analysis of expressions using a custom
function. HAPI's `IFhirPath` adds typed evaluation (`evaluate(input, path, Class<T>)`)
and a parse-once opaque `IParsedExpression` handle. No property/fuzz testing found.

**helios-fhirpath.** Strongest on conformance infrastructure: vendored official R4
(687 cases) and R5 (1037 cases) suites hard-asserting zero failures among non-skipped
cases, and — the standout — a CI job that checks out upstream
`FHIR/fhir-test-cases@master` and runs the official .NET reference validator
(`Hl7.Fhir.FhirPath.Validator`) against their live server, with **release builds
gated on that job**. Exclusions live in a checked-in, reason-annotated
`known-test-failures.json`. Typed value model with first-class `Empty` and per-value
FHIR type metadata (`TypeInfoResult`) plus a `PrimitiveElement` slot for `_field`
siblings. Coverage gated via cargo-llvm-cov + Codecov (±1%), clippy `-D warnings`,
`cargo audit`. Weaknesses: rust_decimal normalizes trailing zeros so
`1.58700.precision()` yields 6 not 5 (a documented, `#[ignore]`d conformance failure);
~413 `unwrap()`s (no no-panic guarantee); the ergonomic API flattens typed errors to
`Result<_, String>`; type inference exists but is display-only, not a gate; no
property/fuzz testing.

**HealthSamurai/fhirpath-editor.** The most sophisticated *inference* engine:
a declarative function-signature table (`functionMetadata`) where each function is
`fn(input, args, returnType)` with Hindley-Milner-style unification
(`matchTypePattern` / `substituteBindings` / `mergeBindings`) over type variables —
so `select()`'s return type is the inferred lambda body type, `where()` preserves the
element type, `iif()` returns the union of its branches, and lambda `$this` context
types are captured for autocomplete inside lambdas. FHIR primitives are modeled as
subtypes of System types (`FHIR.code` isSubtypeOf `System.String`). Diagnostics are
error-as-a-type (`InvalidType` carrying message + source position) that propagate and
short-circuit. External `%variables`' types are inferred from sample values
(`resourceType` sniffing). Weaknesses they concede or exhibit: cardinality checking
(`SingleType`) is **disabled in code** — "adds too much noise in the error messages";
`UnknownType` dead-ends (errors) instead of degrading gracefully, so
`children()`/`descendants()` kill downstream checking; `resolve()` is absent from the
signature table entirely; one severity level; choice-vs-choice unification is O(n!)
permutation search; the analyzer is validated only by curated unit tests, never
against the official conformance suite.

---

## Where fhirpath-ts already leads (baseline to preserve)

- **Exact value types.** BigInt-mantissa + explicit-scale decimal
  (`src/values/decimal.ts`) — no float error, scale doubles as precision. helios
  documents a trailing-zero precision failure here; kotlin's precision is a
  self-admitted TODO. Precision-aware temporals with indeterminate comparison → empty
  (`src/values/temporal-compare.ts`). Exact-factor UCUM subset (`src/values/ucum.ts`).
- **A real §11 analyzer with enforced cardinality.** Samurai built `SingleType` then
  disabled it; kotlin and helios have no static analyzer at all. Ours tracks
  `{ types, single }` through navigation, functions, and operators with stable
  diagnostic codes.
- **Graceful unknown regions.** `children()`/`descendants()`/external `%vars` set
  `types: undefined`, muting downstream checks until narrowed — Samurai's Unknown
  errors instead.
- **Compile-time typed results** (`src/typed/infer.ts`) — none of the four have it.
- **Manifest hygiene.** Skip/quirk manifests fail tests when entries go stale;
  241 documented divergences from fhirpath.js are evidence-backed.
- **Verified already-covered** (checked during this study, no action needed):
  - Primitive `_field` siblings (id/extension on primitives) preserved through
    navigation: `TypedValue.primitiveElement` (`src/values/typed-value.ts:35`),
    attached at `src/fhir/model-navigation.ts:116-120`, value/`_name` array alignment
    and value-only-in-sibling handling (model-navigation.ts:37-52, 76-93), metadata
    read via `readPrimitiveMetadata` (57-74). Tested in
    `model-navigation.test.ts:49,58` and `fhir-extras.test.ts:64,90,97`. kotlin and
    helios both needed explicit designs for this; we match them.
  - Incomparable-unit quantity `=`/`<` return empty, not false
    (`src/values/quantity.ts:167-198`, `src/engine/operators/equality.ts:37-38,218-227`,
    `comparison.ts:40-57`) — matches HAPI's `qtyEqual` → null → empty. Incompatible
    *types* throw `FhirPathTypeError` (comparison.ts:44), matching HAPI's
    `FHIRPATH_CANT_COMPARE`.
  - Parser rejects trailing input via an explicit end-token check
    (`src/parser/parser.ts:33-40`), tested (`parser.test.ts:260`) — the bug class
    kotlin had to guard ANTLR against.
  - Analyzer self-scan runs in CI since `0d838ba`: `pnpm lint` includes the dogfooded
    `fhirpath/no-invalid-expressions` ESLint rule over the library's own source
    (ci.yml:36-40).

---

## WS1 — Phase-tagged conformance testing (from HAPI) — highest leverage

**Their guarantee.** The official suite tags failing expressions
`invalid="syntax|semantic|execution"`, and HAPI's runner asserts the failure lands at
the right phase: syntax → `parse()` throws; semantic → parse succeeds, `check()`
throws; execution → parse and check succeed, `evaluate()` throws. The R5 suite has
2 syntax / 23 semantic / 22 execution cases, plus a `skipStaticCheck="true"`
attribute for expressions that are valid to run but not statically checkable.
Semantic cases worth stealing as analyzer fixtures: `name.given1` (unknown property),
`Encounter.name.given` on a Patient (wrong context),
`(Observation.value as Period).unit` (impossible cast), redefining a
`defineVariable`, referencing undefined `%fam`, overwriting `%context`. Execution
cases: `-1.convertsToInteger()` (precedence), `(1|2).not()`,
`Patient.name.single()` with two names, `@T14:34:28Z.is(Time)`.

**Our verified state.**
- The converter already preserves `invalid` verbatim and `mode`
  (`scripts/convert-official-tests.ts:75-84`) — the distinction survives into our
  JSON; it is collapsed only at runtime.
- The harness runs invalid cases against the evaluator but treats them uniformly:
  "any engine error passes" (`src/testing/official-harness.ts:71-102`, comment
  at :79).
- `mode:'strict'` cases are skipped with the reason "strict static typing errors are
  the job of the analyzer, not the dynamic evaluator"
  (`test-data/official/skip-manifest.ts:32-41`) — **but nothing anywhere runs
  `analyzeExpression` on official-suite cases** (grep-verified). The analyzer has
  zero conformance coverage today. This is the single place where a claim we make
  (analyzer handles the strict layer) is untested against the suite.
- Our error classes already map onto the phases: `FhirPathSyntaxError` /
  `FhirPathTypeError` / `FhirPathRuntimeError` (`src/errors.ts`).

**Proposed.**
1. New analyzer conformance test (e.g. `src/analyzer/official-conformance.test.ts`):
   for official cases with `invalid="semantic"` or `mode="strict"`, run
   `analyzeExpression` with the R4/R5 model and the input resource type, asserting at
   least one error-severity diagnostic. For *valid* cases, assert no error-severity
   diagnostics — the false-positive guard — honoring `skipStaticCheck` and an
   analyzer-specific skip manifest with the same hygiene enforcement as the existing
   manifests (scope per Q4).
2. Tighten the runtime harness: assert the error *class* per `invalid` value
   (syntax → `FhirPathSyntaxError`; execution → runtime/type error) instead of
   accepting any `FhirPathError`.

---

## WS2 — Analyzer type-flow upgrades (from Samurai + HAPI)

**Verified current shape** (`src/analyzer/signatures.ts:28-39`): `FunctionSignature =
{ input?: { kind?: ValueKind, singleton? }, args?: ArgSpec[], result: (input:
StaticStateLike) => StaticStateLike }` with `StaticStateLike = { types: string[] |
undefined, single: boolean }`. No type variables. `select`, `repeat`, `ofType`, `as`,
`children`, `descendants`, and `resolve` all return UNKNOWN (signatures.ts:71-91).
Cardinality is the `single` boolean only. `AnalyzerDiagnostic.severity` is declared
`'error' | 'warning'` (analyze.ts:11) but `report()` hardcodes `'error'`
(analyze.ts:478) — warnings are never emitted. Functions in the runtime registry but
missing from `FUNCTION_SIGNATURES` still get arity checks and degrade to UNKNOWN
(analyze.ts:248-254).

**Adopt, in priority order.**
- (a) **`ofType(X)` / `as X` narrow to the named type** instead of UNKNOWN. Both
  Samurai (`normalizeChoice(ChoiceType([X]))`) and HAPI do this; it is the cheapest
  high-value fix. Intersect with input types where known; `as` keeps `single`.
- (b) **`select(expr)` returns the analyzed type of its lambda body** (Samurai's
  `Lambda<R, Single<T>> → R`): analyze the argument expression with input
  `{ types: input.types, single: true }` and use the resulting state,
  collection-ized. This specific case needs no general unification machinery.
  Samurai's HM-style `matchTypePattern`/`substituteBindings`/`mergeBindings` (their
  type.ts:390-749) is the eventual shape if more functions need type variables
  (`iif` branch union, `aggregate`, `repeat`).
- (c) **`resolve()` reference-target typing** (HAPI `TypeDetails.targets`): use
  `Reference.targetProfile` from the R4 model so `resolve()` yields a type union
  instead of UNKNOWN. Prerequisite: confirm the generated model carries target info;
  extend `scripts/generate-r4-model.ts` if not (Q6). Notably Samurai has no
  `resolve` at all — this puts us ahead of the best analyzer studied.
- (d) **Start emitting warnings** — the severity channel already exists in the type.
  Candidates: always-empty expressions; collection-passed-where-singleton-expected on
  function arguments (HAPI emits this as a warning, `FHIRPATH_COLLECTION_STATUS_PARAMETER`).
- (e) **Element dependencies**: collect the element paths an expression touches
  during the walk and return them on the analysis result (HAPI's `check(...)` has an
  `elementDependencies` out-param). Cheap; enables dependency tracking for callers
  and future editor tooling.
- (f) **ORDERED/UNORDERED collection status** (HAPI's `CollectionStatus` with its
  union/first/etc. algebra) — the only consumer is diagnostics on ordered-dependent
  functions; deferred pending Q3.
- (g) **Primitive→System subtyping** largely exists via `FHIR_PRIMITIVE_TO_SYSTEM` +
  `valueKindOfTypeName` (signatures.ts:4-27). Samurai's finer per-primitive subtype
  hierarchy is only needed if the `ValueKind` buckets prove too coarse for a real
  diagnostic — revisit on evidence, not preemptively.
- **Keep as deliberate design** (both are places Samurai is weaker): graceful unknown
  regions and stable diagnostic codes.

---

## WS3 — Custom functions must join the analyzer (from HAPI)

**Their guarantee.** A host-provided function participates in all three phases:
`resolveFunction` (existence + arity, consulted at parse), `checkFunction` (static:
validates argument `TypeDetails`, returns the result type — wired into the type
checker at `FHIRPathEngine.java:3965`), `executeFunction` (runtime). Constants are
paired the same way (`resolveConstant` / `resolveConstantType`). A custom function
without the check leg turns every expression using it into an analysis blind spot.

**Our state.** No public mechanism yet (`registerFunction` is internal,
`src/functions/registry.ts:39-48`, throws on duplicates). The pending plan
`ai-plans/2026-07-07-API-DEVEX-CUSTOM-FUNCTIONS.md` (v1, user-confirmed decisions:
plain JS values in/out, eager args only, no built-in override; analyzer gets
`functions?: Record<string, { minArity?, maxArity? }>` and treats registered names as
known-but-opaque UNKNOWN regions) already covers the resolve and execute legs and
keeps the analyzer *sound* — it lacks only the optional static-typing leg.

**Proposed extension (does not contradict v1).** Optional
`signature?: { input?: { kind?, singleton? }, args?: ArgSpec[], result?: { types, single } }`
on `CustomFunction`, mapping directly onto the analyzer's `FunctionSignature`, so a
typed custom function participates in analysis instead of muting it. The same idea
applies to external variables (HAPI's `resolveConstantType`): an
`AnalyzeOptions.variables` map with declared types, so `%vars` need not always be
unknown regions. Timing — inside the v1 implementation or as a follow-up — is Q2.
Implementation note: the v1 doc's line refs are stale after `0d838ba`
(`AnalyzeOptions` at analyze.ts:17 → 18-22; the evaluator `'call'` case moved) —
refresh them when implementing.

---

## WS4 — Testing & CI guarantees

- **Coverage gate.** Thresholds are configured (99 lines / 99.5 funcs / 96 branches /
  99 stmts, vitest.config.ts) but CI runs `pnpm test` (ci.yml:46), so they guarantee
  nothing. Switch CI to `pnpm coverage`. One-line change; helios gates coverage via
  cargo-llvm-cov + Codecov.
- **Upstream drift watch.** helios's CI checks out `FHIR/fhir-test-cases@master` and
  runs the official .NET validator against a live server, gating releases. Our
  equivalent: a scheduled workflow re-running `scripts/convert-official-tests.ts`
  against upstream master and diffing against the vendored snapshot, reporting new or
  changed cases (cadence and report-vs-fail mode: Q7). kotlin is the cautionary tale:
  it vendors only R4 while shipping R4B/R5 engines with no conformance coverage —
  relevant when we add R5/R4B model packages.
- **Property-based + differential fuzzing.** None of the four implementations have
  any (verified: no proptest/quickcheck/cargo-fuzz in helios or kotlin, none in HAPI,
  none here — no fast-check in our devDependencies). Adding it puts us ahead of the
  entire field studied:
  1. Parser round-trip fuzzing — generate random ASTs, print via `src/parser/printer.ts`,
     re-parse, compare.
  2. Differential evaluation vs fhirpath.js on generated expressions over fixture
     resources, with disagreements triaged through the existing quirk-manifest
     mechanism.
  3. Value-type properties: decimal arithmetic laws, temporal comparison symmetry/
     transitivity at mixed precisions.
  Fixture/synthetic resources only.
- **Public conformance table** (kotlin's strongest transparency practice). Our README
  already has pass/skip counts and category prose (README.md:177-206); add a
  root-cause class per skip category (`Implementation` / `Test bug` /
  `Spec ambiguity`) with links, and adopt the practice of filing upstream
  `fhir-test-cases` issues for cases we believe are wrong — we currently have four
  documented "suite oddities" plus boundary-function disputes worth filing (kotlin
  links each of theirs to a fhir-test-cases PR/issue or HL7 JIRA/chat thread).

---

## WS5 — Runtime hardening: ReDoS (the one open runtime gap)

`matches` / `matchesFull` / `replaceMatches` compile user patterns via `compileRegex`
(`src/functions/string.ts:129-161`) with no guards beyond the invalid-syntax
try/catch. README Security (README.md:320-331) documents the risk and calls a true
timeout "impractical without native dependencies" — accurate for a synchronous JS
engine (HAPI's fix, `regexTimeoutMillis = 500`, is not portable to us). Options:

- (i) **Static detection** — an analyzer/ESLint diagnostic flagging
  catastrophic-backtracking-prone patterns in literal regex arguments (nested
  quantifiers / star-height heuristics). Fits our architecture: the strict layer
  catches what the lenient runtime cannot.
- (ii) **Pluggable regex engine hook** — an option to supply a linear-time engine
  (e.g. an RE2 binding) for `matches`-family functions, keeping the zero-dependency
  default.
- (iii) **Subject/pattern length caps** as evaluate options.

Recommendation: (i) + (ii), keeping the documented caveat for the default path.
Final choice is Q1.

---

## Open questions

- **Q1** ReDoS approach: static detection, pluggable engine, length caps — which
  combination? (WS5 recommendation is (i) + (ii).)
- **Q2** Custom-function `signature` and typed `%variables`: fold into the pending v1
  custom-functions implementation, or ship v1 arity-only first and extend after?
- **Q3** ORDERED/UNORDERED collection tracking: worth the algebra? The only consumer
  is diagnostics on ordered-dependent functions (`first`, `skip`, indexers after
  unordered operations).
- **Q4** Analyzer false-positive guard (WS1): running *all* valid official cases
  through the analyzer will surface expressions the analyzer cannot type — accept a
  separate analyzer-skip manifest (with the same hygiene enforcement), or initially
  assert only on the invalid/strict subset?
- **Q5** Does `convert-official-tests.ts` preserve `skipStaticCheck`? It preserves
  `invalid`, `mode`, `predicate`, and `inputfile`; `skipStaticCheck` is unverified —
  check and extend during WS1.
- **Q6** Is `Reference.targetProfile` present in the generated R4 model data? If not,
  extend `scripts/generate-r4-model.ts` (prerequisite for WS2c).
- **Q7** Upstream drift watch: cadence (weekly/monthly) and mode (report-only issue
  vs failing check)?

---

## Suggested sequencing

1. WS4 coverage gate (one line) + WS1 analyzer conformance harness — converts our
   biggest skip category into a tested guarantee.
2. WS2 (a) `ofType`/`as` narrowing, then (b) `select` body typing and (d) warnings.
3. WS3 signature extension, aligned with the custom-functions v1 implementation.
4. WS4 fuzzing, drift watch, README conformance table.
5. WS2 (c, e–g) and WS5 per the Q1 decision.
