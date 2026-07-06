# TypeScript-Native FHIRPath Engine — `fhirpath-ts`

> On implementation start: copy this plan to `ai-plans/2026-07-03-FHIRPATH_IMPLEMENTATION_PLAN.md` (repo convention) and keep it updated via its Amendments section.

## Context

Build a spec-faithful, TypeScript-native FHIRPath implementation at `packages/fhirpath`, following https://hl7.org/fhirpath/ closely, with inspiration from fhirpath.js (HL7 reference impl), fhirpath-py, fhirpath-rs, and Medplum's engine (local checkout at `/home/fjsj/workspace/medplum/packages/core/src/fhirpath/`, Apache-2.0 — the closest hand-written-TS precedent, but a pragmatic subset: `repeat`/`children`/`descendants`/`split`/`trim`/encode-family are stubs, float decimals, no official-suite run, no static typing).

Why: the repo's FHIR-mapper effort (`feat/fhir-json-mapper`, ClickUp 869dn0xt7) needs a typed expression engine; no existing implementation offers compile-time type safety — **nobody has shipped template-literal-type result inference for FHIRPath strings** (verified: fhir-dsl is a fluent builder, atomic-ehr analyzes at runtime only). This package fills that niche and stays FHIR-generic with zero `@vinta-bb` deps so it's extractable to OSS later.

**User-confirmed decisions:**
1. Location: `packages/fhirpath` (`fhirpath-ts`) in this monorepo.
2. Type safety (spec §11): **hybrid** — (a) pure template-literal-type inference for a tractable subset (works in plain `tsc`, degrades to `unknown[]`), gql.tada-style; (b) full static analyzer (real parser + ModelProvider, §11 strict rules) exposed as CLI + optional ESLint rule, safeql-style; dual-tested arktype-style so type-level and runtime agree.
3. Model-agnostic core behind a `ModelProvider` interface (spec ModelInfo concept); generated **R4 model first** (subpath export `./r4`).
4. **Sync-only, no terminology in v1**: no `memberOf`/`%terminologies`; `resolve()` only sync within Bundle/contained. README tracks all deferred features for future tasks.
5. ~100% coverage with enforced vitest thresholds; run the official test suite + port reference-implementation cases.

**Scope — the core FHIRPath language spec (hl7.org/fhirpath) is implemented 100%, no subset:** FHIRPath 2.0.0 (N1) normative + its STU parts (math §5.7, aggregates §7, reflection §10.2) + 3.0.0-ballot STU functions the official R5 suite exercises (`defineVariable`, `lowBoundary`/`highBoundary`/`precision`, `trim`/`split`/`join`/`encode`/`decode`/`escape`/`unescape`, `lastIndexOf`, `matchesFull`, `toLong`, `yearOf`-family) + FHIR-specific additions from hl7.org/fhir/fhirpath.html (`extension(url)`, `hasValue`/`getValue`, choice-type navigation `Observation.value`, primitive `.extension`/`.id` via `_field`, sync `resolve()` within Bundle/contained, `%resource`/`%rootResource`, real `htmlChecks()` XHTML narrative validation, FHIR `~` tweaks: Coding system+code, CodeableConcept intersection, ignore `id`).

**Excluded v1** — every exclusion is from the FHIR extensions page, none from the core language spec (README "Deferred Features" tracks each with a future-task pointer):
- *Consequence of the locked "sync only, no terminology" decision:* `memberOf`, `subsumes`/`subsumedBy`, `%terminologies` API, `weight()` (needs code-system lookups), async/network `resolve()`.
- *Profile/validator machinery (registered, throw clear "not supported in v1" errors):* `conformsTo`, `slice`, `elementDefinition`, `checkModifiers` — implementing these means embedding a FHIR validator; the reference implementation (fhirpath.js) doesn't implement them either. `%factory` (R5 draft type-factory API) likewise.
- *Different data model:* CDA mode (official-suite `mode="cda"` group) — the ModelProvider interface keeps a CDA model possible later.
- *Depth limit, with hard contingency:* full UCUM conversion — v1 ships a built-in unit table covering everything the official suites exercise; **if any non-skipped conformance case fails on units in Phase 11, `@lhncbc/ucum-lhc` goes in** (it's what fhirpath.js uses).

## Guiding Decisions

| Decision | Resolution |
|---|---|
| Parser | Hand-written lexer + Pratt parser (adapt Medplum's `ParserBuilder` prefix/infix-parselet + precedence-enum pattern; Apache-2.0 attribution headers on adapted files). ANTLR rejected: runtime dep + codegen step vs repo's no-build convention. Normative grammar `https://hl7.org/fhirpath/fhirpath.g4` is source of truth. |
| AST | Plain discriminated-union nodes with source spans (not Medplum's class `Atom.eval`) — one serializable AST shared by evaluator, printer, analyzer, and conformance tooling. |
| Value model | Internal `TypedValue` collections `{ type, value }`; public API returns unwrapped `unknown[]`; typed escape hatch exposed. |
| Decimal | Own zero-dep BigInt-scaled fixed-point module (exact `+ - * / div mod`, compare, round/truncate, precision tracking for `lowBoundary`/`highBoundary`/`precision`); transcendentals (`sqrt ln exp log power`) via `Number`, re-wrapped. Contingency behind the module boundary: swap internals to `decimal.js-light` if official decimal groups expose gaps. |
| UCUM | Minimal built-in table (SI prefixes + units the official suites need) for comparability/conversion; `@lhncbc/ucum-lhc` rejected (heavy; spec only SHOULDs full UCUM). Calendar vs UCUM durations: `1 year = 1 'a'` → false, `~` → true; `second`-and-below equal. Limits documented. |
| Model data source | Generate from R4 StructureDefinitions in `@medplum/definitions` (already in catalog ^5.1.6) — generator takes a Bundle path, source-swappable. Committed, deterministic (sorted) output. Five datasets, mirroring fhirpath.js's `fhir-context/r4`: choiceTypePaths, pathsDefinedElsewhere (contentReference), path2Type (+cardinality), type2Parent, resourcesWithUrlParam. |
| Model packaging | Subpath export `fhirpath-ts/r4` in the same package; core import never pulls R4 data. One generator emits runtime tables **and** type-level maps from the same in-memory data → lockstep by construction. Generated types are self-contained (structural, compatible with `@medplum/fhirtypes` resources) — keeps the package zero-dep. |
| API | `evaluate(expr, input, options?) → unknown[]`; `compile(expr, options?) → CompiledExpression` (reusable, exposes `.ast`); tagged template `` fhirpath`...` `` (typed from Phase 12). Options `{ model?, env?, now? }` (injectable clock → deterministic `now()/today()/timeOfDay()`). Module-level LRU (~500) parse cache for `evaluate`; `compile` = explicit cache-free path. |
| Errors | `FhirPathError` → `FhirPathSyntaxError` (line/column/span), `FhirPathTypeError` (semantic; singleton violations; undefined `%var`), `FhirPathRuntimeError`. Maps 1:1 to official suite `invalid="syntax|semantic|execution"`. |
| Scoping | Frame stack: `$this`/`$index`/`$total` per iteration frame; `defineVariable` pushes expression-scoped frame (redefinition → error); `%env` map separate; undefined `%var` → error, defined-but-valueless → `{}`. Built-ins: `%context`, `%ucum`, `%sct`, `%loinc`, `%resource`, `%rootResource`. |
| Function registry | `name → { arity, evaluate(ctx, input, argAsts) }` receiving **unevaluated arg ASTs** (lambdas + lazy `iif`). Append-only registration to minimize stacked-PR conflicts. |
| Semantics traps to encode from spec verbatim | 13-level precedence table (`.` > `[]` > unary > `* / div mod` > `+ - &` > `is as` > `|` > comparisons > equality > `in contains` > `and` > `xor or` > `implies`); 3-valued logic tables from §6.5 tested all 9 cells/operator (**verified against normative spec: `∅ implies false` = `∅`, `false implies x` = `true`, `∅ and false` = `false` — one research source had this wrong; trust only the spec tables**); `=` empty-propagating vs `~` never-empty (`{} ~ {}` = true); date/time precision mismatch: `=` → empty, `~` → false; singleton rules (1 item + expected Boolean → true; >1 → error); `&` treats empty as `''` while string `+` propagates empty; `/`, `div`, `mod` by 0 → empty; `/` always Decimal; root identifier resolved as type name first (`Patient.name` on Patient context). |
| `htmlChecks()` | **Real implementation** (user steer: no pragmatic subset): validate narrative XHTML against FHIR's allowed-elements/attributes/css rules with a small built-in XHTML tokenizer (no dependency); official html-mode tests run instead of skipping. |
| Profile fns / CDA | `conformsTo`/`slice`/`elementDefinition`/`checkModifiers`/`%factory` registered but throw descriptive errors; CDA-mode suite group skip-listed. Defaults chosen after 3 unanswered question rounds — cheap to revisit via plan amendment. |
| Conformance corpus | Vendor official suite from `FHIR/fhir-test-cases` (Apache-2.0): r4 `tests-fhir-r4.xml` (937 tests) + r5 `tests-fhir-r5.xml` (1053 tests, source of truth), converted offline to committed JSON; JSON input fixtures; typed skip-manifest with mandatory reasons (terminology/CDA/profile-fns/R5-model-only); harness prints + asserts compliance %. Also vendor fhirpath.js `test/cases/*.yaml` where they add coverage (honor `disable:` flags) — license check first. |
| Type-test tooling | vitest `expectTypeOf` + `--typecheck` project; dual-test helper asserts type-level inference and runtime result agree per table entry. |
| CI integration (repo uses Biome, not ESLint) | (1) analyzer as programmatic API (`./analyzer`); (2) `fhirpath-check` CLI (TS compiler API scans for tags/literal args; runs via Node ≥22 type stripping — repo enforces `erasableSyntaxOnly`); (3) optional ESLint flat-config rule at `./eslint` for external consumers (`eslint` devDep only). No separate plugin package. |
| Coverage | Package vitest `thresholds` (new for repo; watermarks stay central): 95% from Phase 3 → 100/100/100/100 in Phase 14. |
| Deps | Runtime: **zero, ever**. DevDeps added to catalog + `.syncpackrc.json` together in the introducing PR: `fast-xml-parser`, `yaml`, `eslint`. |

## Phased Rollout

**Workflow (user-confirmed): one feature branch; each phase = one commit (Conventional Commits), independently testable — tests/typecheck/lint green at every commit; a single PR for the whole package once done.** Model tier per phase noted.

### Phase 1 — Scaffold + lexer *(mid)*
Package per repo conventions: `package.json` (private, type module, exports `"." → ./src/index.ts`, scripts `typecheck`/`test`/`test:watch`/`coverage` — mirror `packages/shared`), `tsconfig.json` extends root, `vitest.config.ts` (merges shared vite config, discovered by root projects glob), README stub. `src/errors.ts` (error classes). `src/lexer/{tokens,lexer}.ts`: full lexical grammar — identifiers, backtick-delimited identifiers, string escapes incl. `\uXXXX`, Integer/Decimal (no exponent), `@date`/`@dateTime`/`@Ttime` partial precisions, quantity unit strings + calendar keywords, `//` and `/* */` comments, all operators; every token has a span; malformed → positioned `FhirPathSyntaxError`.
**Tests:** token-kind tables, every escape, partial precisions, error positions; adapt Medplum `tokenize.test.ts` as floor.

### Phase 2 — Pratt parser, AST, printer *(high — precedence is load-bearing)*
`src/parser/precedence.ts` (13 levels), `ast.ts` (discriminated unions + spans), `parser.ts` (prefix/infix parselets), `printer.ts` (canonical `toString` with `parse(print(parse(e))) ≡ parse(e)` property).
**Tests:** precedence matrix for every adjacent level pair (`a implies b or c`, `1 | 2 = 3`, `a as B | c`, `-1.convertsToInteger()`); round-trip over a corpus incl. **all official-suite expression strings parse without error** (vendor expressions early); adapted Medplum `parse.test.ts`; error positions.

### Phase 3 — Value model, Decimal, evaluator core, public API *(high)*
`src/values/{decimal,typed-value,collection,datetime}.ts` (Decimal per decision; singleton evaluation rules; partial-precision date/time representation), `src/model/{provider,dynamic}.ts` (`ModelProvider` interface + model-less fallback inferring System types from JSON), `src/engine/{context,evaluator}.ts` (literals, member access with flattening, indexer, `$this`, env vars), `src/api/{evaluate,compile,tagged,cache}.ts` (tagged template untyped for now). Coverage thresholds → 95.
**Tests:** decimal exactness (`0.1 + 0.2 = 0.3`), navigation over nested JSON, singleton matrix, undefined-`%var` error, LRU behavior, API shapes.

### Phase 4 — Operators *(high)*
`src/engine/operators/{equality,comparison,logic,math,strings,collections,types}.ts`: `= != ~ !~` (per-type semantics; collections ordered pairwise; date precision → empty/false split), `< > <= >=` (string ordinal, Integer→Decimal, date partial precision → empty), 3-valued `and or xor implies` + `not()` encoded as literal tables from spec §6.5, `+ - * / div mod` (Decimal-backed, ÷0 → empty, overflow → empty), unary `+/-`, date ± quantity (calendar rollover; truncation of finer-than-precision durations), `&` vs `+`, `| in contains`, `is as` (System + model hook).
**Tests:** all 9 cells × 4 logic operators; equality/equivalence type-pair matrix; date precision matrix; ÷0 family. Quantity-dependent cells marked deferred → Phase 8.

### Phase 5 — Functions I: existence, filtering, subsetting, combining, control, tree *(mid-high)*
`src/functions/registry.ts` + `existence.ts` (`empty exists(criteria?) all allTrue anyTrue allFalse anyFalse count distinct isDistinct subsetOf supersetOf`), `filtering.ts` (`where select repeat ofType` — real cycle-safe `repeat`, unlike Medplum's stub), `subsetting.ts` (`single first last tail skip take intersect exclude`), `combining.ts` (`union combine`), `control.ts` (lazy `iif`), `tree.ts` (`children descendants`, dynamic-model now, model-aware in Phase 10), `utility.ts` (`trace` with pluggable sink, default no-op — README notes trace sinks must never log PHI values, per org policy).
**Tests:** spec examples per function; `$index`/nested-frame leak tests; `iif` laziness via throwing branch; `repeat` cycle termination.

### Phase 6 — Functions II: strings + conversions *(mid)*
`string.ts` (`indexOf substring startsWith endsWith contains upper lower replace matches matchesFull replaceMatches length toChars` + STU `trim split join encode decode escape unescape lastIndexOf`; dotall regex semantics, `matchesFull` anchored), `conversion.ts` (all `toX`/`convertsToX` incl. `toLong`; exact spec conversion tables; non-convertible → empty; >1 → error).
**Tests:** full conversion matrix from spec tables; unicode/empty-string edges; encode/decode round-trips.

### Phase 7 — Functions III: math, boundaries, aggregates, reflection, defineVariable *(mid-high)*
`math.ts` (§5.7: `abs ceiling exp floor ln log power round sqrt truncate`; domain errors → empty), `boundary.ts` (`lowBoundary highBoundary precision` over Decimal/Date/DateTime/Time/Quantity), `date-components.ts` (`yearOf`…`timezoneOffsetOf dateOf timeOf`), `aggregate.ts` (`aggregate` + `$total`; `sum min max avg` as sugar), `reflection.ts` (`type()` → `SimpleTypeInfo/ClassInfo/ListTypeInfo/TupleTypeInfo`, namespace-aware), `variables.ts` (`defineVariable`), `utility.ts` (`now today timeOfDay` from injected clock).
**Tests:** ballot boundary/precision tables; `$total` init/empty; `type()` shapes ± model; defineVariable shadowing/redefinition error; deterministic clock.

### Phase 8 — Quantity + UCUM subset *(high — fiddly)*
`src/values/{ucum,quantity}.ts`: canonicalization for comparability, `+ - * /` unit algebra to supported extent, calendar-vs-UCUM `=`/`~` split, definite-duration table (week and below definite). Un-defer Phase 4/6 quantity markers.
**Tests:** spec quantity examples; `1 'm' = 100 'cm'`; year/`'a'` matrix; dimension mismatch → empty/error per spec.

### Phase 9 — R4 model generation *(mid)*
`scripts/generate-r4-model.ts` reading `@medplum/definitions` bundles → `src/r4/generated/*.ts` (`as const`, sorted, manifest header) + `src/r4/index.ts` (`r4Model: ModelProvider`) + package.json `"./r4"` subpath. Sanity cross-check log vs fhirpath.js `fhir-context/r4` JSON (read-only comparison).
**Tests:** generator over fixture bundle; snapshot of stable output slice; `Patient.name` → HumanName, `Observation.value[x]` choices, `Questionnaire.item.item` contentReference recursion, hierarchy walks.

### Phase 10 — FHIR extras *(high)*
`src/fhir/{choice,primitives,extensions,resolve,equivalence}.ts`: choice navigation via model tables + `ofType/is/as` interop; primitive `_field` extension/id access + `hasValue()/getValue()`; `extension(url)`; sync `resolve()` (contained `#id`, Bundle fullUrl/type+id, else empty, never network); FHIR `~` tweaks active when FHIR model present; `%resource`/`%rootResource` wiring; `src/fhir/html-checks.ts` — real `htmlChecks()` (built-in XHTML tokenizer validating FHIR narrative rules: allowed elements/attributes, no scripts/event handlers, `xhtml` namespace); `conformsTo`/`slice`/`elementDefinition`/`checkModifiers`/`%factory` throwing stubs locked by tests.
**Tests:** choice navigation across representative resources; primitive-extension fixtures; Bundle/contained resolve; `%resource` inside `descendants().where(...)`; htmlChecks positive/negative narrative fixtures (valid narrative, script tag, bad attribute, wrong namespace).

### Phase 11 — Conformance: official suites + fhirpath.js cases *(high — schedule risk, budget for a long bug-fix tail)*
Add `fast-xml-parser` + `yaml` (catalog + syncpack). `scripts/convert-official-tests.ts` → committed JSON under `test-data/official/{r4,r5}/` (preserve `invalid=`, `predicate=`, `mode=`, group names, ordered flags) + JSON fixtures + upstream LICENSE. `test-data/official/skip-manifest.ts` (typed, mandatory reasons). `src/testing/official-harness.ts` + `official.test.ts` (predicate → boolean-exists; `invalid=` → mapped error class; per-suite compliance % printed and asserted ≥ threshold). Vendor fhirpath.js YAML section files adding coverage + collector test. Fix all failures here or skip-list with reason — no new features.
**Exit criterion:** ≥98% of non-skipped official cases passing; every skip has a reason string.

### Phase 12 — Type-level inference layer *(high — type-level programming)*
Extend generator to emit `src/r4/generated/type-maps.ts` (self-contained type-level path→type + choice + hierarchy maps). `src/typed/{parse,infer}.ts`: template-literal-type parser for the subset — dotted paths, `[n]`, `first()/last()/single()`, type-preserving `where(...)`, `select(...)` of subset projections, `ofType(X)`/`as`, `exists()/empty()/count()`, choice resolution — depth-bounded, anything else → `unknown[]` (degradation, never an error). `fhirpath` tag returns `TypedCompiledExpression<Expr>`. Dual-test helper (`src/testing/dual.ts`) + vitest typecheck project. CI tsc-perf fixture (~100 typed expressions through the normal `typecheck` script).
**Tests:** inference per subset feature + degradation cases; dual tables (type-level and runtime agree); `@ts-expect-error` suite for invalid paths.

### Phase 13 — Static analyzer (§11) + `fhirpath-check` CLI + ESLint export *(high)*
`src/analyzer/{analyze.ts,rules/*}`: static type+cardinality inference over the AST with ModelProvider, then spec §11's six unsafe-use rules (non-singleton input to singleton function; non-singleton argument; wrong input/arg type; non-singleton operator operands; wrong operand types; incomparable equality operands) + unknown element/function/type diagnostics, each rule a module emitting `{ severity, code, message, span }`; `as`/`ofType` after `children()`/`descendants()`/choice elements narrows as the spec prescribes. Subpath `./analyzer`. `src/cli/fhirpath-check.ts` (+ `bin`, script `check:fhirpath`): TS compiler API scan of tags + literal `evaluate/compile` args, positioned diagnostics, nonzero exit. `src/eslint/index.ts` at `./eslint` (flat config; `eslint` devDep in catalog/syncpack). README documents Biome-repo integration.
**Tests:** rule-by-rule positive/negative; CLI over fixture files (positions + exit code); ESLint `RuleTester`; analyzer/runtime agreement spot-checks.

### Phase 14 — Docs, 100% coverage, perf polish *(mid)*
README: full API + type-inference subset definition + compliance table (official R4/R5 % + skip summary) + **Deferred Features register** (terminology, `memberOf`, `subsumes`, `weight()`, `%terminologies`, `%factory`, `conformsTo`/`slice`/`elementDefinition`/`checkModifiers`, CDA mode, async resolve, full UCUM — each with future-task pointer) + attribution/licensing + PHI note for `trace`. Thresholds → 100/100/100/100; fill gaps; `/* v8 ignore */` only with justification. `scripts/bench.ts` micro-benchmarks (not in CI); fix pathological hot paths (hash-based `distinct`/union). AGENTS.md package-list touch-up if applicable.

## Verification (end-to-end)

- Per phase: `pnpm --filter fhirpath-ts test` and `pnpm --filter fhirpath-ts coverage` (thresholds enforce); root `pnpm typecheck` + `pnpm check` (Biome) + `pnpm deps:check` (syncpack) must stay green.
- Phase 11 gate: official-suite harness prints per-suite compliance; the final PR description includes the table; skip-manifest hygiene test fails if a skip entry matches zero cases.
- Phase 12 gate: `vitest --typecheck` project green; dual tables prove type/runtime agreement; tsc-perf fixture within normal `typecheck` runtime.
- Phase 13 gate: `pnpm --filter fhirpath-ts check:fhirpath` over fixture files; ESLint RuleTester suite.
- Final smoke: from a scratch script, `evaluate('Patient.name.given', patient)` and `` fhirpath`Patient.name.given` ``.evaluate(patient) return identical values with the latter typed `string[]`.

## Risks

- **Own Decimal** is the riskiest zero-dep bet — contingency swap to `decimal.js-light` is a one-module change; watch Phase 11 decimal groups (Medplum's float divergences are the cautionary tale).
- **Type-level parser perf/instantiation limits** — subset deliberately small + depth-bounded; degradation to `unknown[]` is the escape valve; perf fixture guards CI (gql.tada needed turbo-caching at much larger scale).
- **Phase 11 long tail** — allowed to grow bug-fix commits, not features.
- **Generated model size** as TS source — generator already splits files; split further per resource group if editor/tsc strain appears.
- Single-PR-at-the-end means a large final review — mitigated by phase-per-commit history (reviewable commit by commit) and the plan itself serving as the review map.

## Open Questions (non-blocking)

1. fhirpath.js YAML corpus license — confirm before vendoring in Phase 11 (fallback: derive equivalent cases from spec text; official suite alone already covers most).
2. `sum/min/max/avg` sugar in v1 — proposed yes, decide during Phase 7.
3. npm publication later would need a build step (breaks source-consumption convention) — affects whether `./r4` data stays TS or moves to JSON; out of scope now.
4. Whether the fhir-mapper branch wants public AST visitor affordances — check when it consumes this package.

## Touch List

- `packages/fhirpath/`: `package.json`, `tsconfig.json`, `vitest.config.ts`, `README.md`
- `packages/fhirpath/src/`: `index.ts`, `errors.ts`, `api/{evaluate,compile,tagged,cache}.ts`, `lexer/{tokens,lexer}.ts`, `parser/{precedence,ast,parser,printer}.ts`, `values/{decimal,typed-value,collection,datetime,quantity,ucum}.ts`, `model/{provider,dynamic}.ts`, `engine/{context,evaluator}.ts`, `engine/operators/*.ts`, `functions/*.ts`, `fhir/{choice,primitives,extensions,resolve,equivalence,html-checks}.ts`, `r4/{index.ts,generated/*}`, `typed/{parse,infer}.ts`, `analyzer/{analyze.ts,rules/*}`, `eslint/index.ts`, `cli/fhirpath-check.ts`, `testing/{official-harness,dual}.ts`, colocated `*.test.ts` throughout
- `packages/fhirpath/scripts/{generate-r4-model,convert-official-tests,bench}.ts`
- `packages/fhirpath/test-data/{official/{r4,r5,fixtures,skip-manifest.ts,LICENSE},fhirpathjs/{*.yaml,LICENSE}}`
- Root: `pnpm-workspace.yaml` + `.syncpackrc.json` (devDeps: `fast-xml-parser`, `yaml`, `eslint`), `ai-plans/2026-07-03-FHIRPATH_IMPLEMENTATION_PLAN.md` (copy of this plan)

## Key references

- Spec: https://hl7.org/fhirpath/ (2.0.0 N1) · grammar https://hl7.org/fhirpath/fhirpath.g4 (source of truth) · ballot https://hl7.org/fhirpath/2025Jan/ · FHIR additions https://hl7.org/fhir/fhirpath.html
- Official tests: https://github.com/FHIR/fhir-test-cases → `r5/fhirpath/tests-fhir-r5.xml` (1053 tests, source of truth) + `r4/.../tests-fhir-r4.xml` (937)
- Architecture reference: `/home/fjsj/workspace/medplum/packages/core/src/fhirpath/` (+ `fhirlexer/`) — Pratt parser + function registry patterns
- Model-data shape: fhirpath.js `fhir-context/r4` five JSON datasets
- Type-safety prior art: gql.tada (type-level parsing + degradation), arktype (dual static/dynamic parsers + lockstep tests), safeql (lint-time real-engine validation)

## Amendments

### 2026-07-03 — Phase 14 outcomes

- **Coverage landed at a locked floor, not 100/100/100/100.** Final enforced vitest thresholds: 99% statements / 96% branches / 99.5% functions / 99% lines (achieved: 99.4 / 96.5 / 99.8 / 99.3). The uncovered remainder is annotated `v8 ignore` defensive guards (exhaustiveness defaults on discriminated unions, impossible states) and fallback halves of guards on shapes real FHIR data does not produce. Chasing the last fraction would mean deleting defensive code or writing tests for unreachable states; the floor is documented in `vitest.config.ts` and the README Coverage section.
- **Tagged-template typing limitation.** TypeScript cannot infer literal types through tagged templates (microsoft/TypeScript#33304), so `` fhirpath`...` `` stays `unknown[]`; the typed forms are `fhirpath('...')` and `compile('...')` call syntax. Documented in the README; the `fhirpath-check` CLI and ESLint rule still statically check the tag form.
- **Conformance final numbers.** R4: 923/935 pass, 12 skipped; R5: 1,026/1,051 pass, 25 skipped; zero non-skipped failures. All skips carry reasons in `test-data/official/skip-manifest.ts` with a hygiene test that fails on stale entries.
- **Corpus deviations.** fhirpath.js YAML corpus was not vendored (Open Question 1 resolved: official suites + spec-derived unit tests already covered the material; avoids the extra `yaml` devDep and license review). `sum/min/max/avg` sugar shipped (Open Question 2: yes).
- **Workflow (user-directed).** Single branch `feat/fhirpath-engine`, one commit per phase, one PR at the end — replacing any stacked-PR assumption.
- **Node type-stripping requirement.** All relative imports use explicit `.ts` extensions (with `allowImportingTsExtensions`) so the `fhirpath-check` CLI runs under Node's type stripping without a build step.

### 2026-07-03 — Post-review fixes (PR #269 review round 1)

Applied from the security/quality review: bounded UCUM and decimal exponents
(DoS), entity-decoding scheme allowlist in `htmlChecks()` (XSS), own-property
navigation (prototype leak), `convertsToQuantity(unit)` honoring its argument,
parser depth cap (500), linear-time lexer spans, static operator dispatch tables
with compile-time exhaustiveness (install.ts side-effect registration removed),
duplicate function-registration throw, signature/registry sync test, choice
`_field`-sibling navigation, printer type-specifier escaping, CLI/ESLint
foreign-import gating, and a README expression-trust-boundary note.

Declined, with rationale:
- **TypedValue as a discriminated union** — a foundational re-plumbing of the
  value model across conversion/string/equality/quantity/temporal code for
  type-tidiness, not correctness; the `systemTypeOf()` twin-dispatch design is
  load-bearing for the FHIR-vs-System type split the official suites lock down.
  Revisit only alongside another value-model change (e.g. the R5 model task).
- **Regex execution timeout** — impractical without native deps or workers in a
  zero-dependency sync engine; documented as the expression trust boundary in the
  README Security section instead.

### 2026-07-04 — Reference-corpus round (Open Question 1 revisited)

The fhirpath.js YAML corpus (plus fhirpath-py's two extra files) is now vendored
after all — as converted JSON under `test-data/fhirpathjs/` with the NLM license,
run by `src/fhirpathjs.test.ts`: 2,289 cases pass; non-R4-model and
upstream-disabled cases skip; 241 cases are documented intentional divergences in
`quirk-manifest.ts`, each family with spec/official-suite evidence (e.g. their
`~` trims whitespace where §6.1.2 only makes whitespace characters
interchangeable; their `1 month = 30 days`; their `matches()` flags argument;
their lenient `\u12` escapes; Medplum's `(0).not() = true` contradicting the
official `(0).not() = false`). fhirpath-rs was reviewed and is a regrouped
official R5 suite plus custom cases ported to `reference-crosschecks.test.ts`.

Engine changes the corpus surfaced (all official suites still 100%): Long
literals, temporal literal validation (day-in-month, ±14:00 offsets, leap
second), time-arithmetic errors for date-level units, fraction truncation at the
original unit, day→year via 365, implicit numeric→Quantity conversion, FHIR UCUM
time-code → calendar mapping, calendar conversions/scaling/ratios, quantity
aggregates, coalesce() (ballot §5.2.8), substring's empty length, component
functions empty for non-temporal input, millisecond-precision clock, and — the
substantive design change — **runtime navigation is now lenient** like the
reference engines: plain unknown elements yield empty (the §11 analyzer owns typo
detection), the only runtime semantic error the official default mode pins being
choice-key misuse (`Observation.valueQuantity`). children()/descendants() are
model-aware via the new optional `ModelProvider.listElements()`.
