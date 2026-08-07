# Full type-level FHIRPath inference from current main

> Status: **plan only, not scheduled**. This replaces PR #15's July plan with a
> design based on current `main`. The implementation is one PR, split into green
> commits in the order below. Keep this document current through its Amendments
> section once implementation starts.

## What users gain

Today `FhirpathResult<Expr>` precisely types a useful subset: model navigation,
indexers, choice stems, selected identity and fixed-return calls, `select()` over
inferable subexpressions, unions, groups, and `%var` roots ending in a fixed
return. An operator or a result-dependent call usually makes the whole expression
`unknown[]`, even though the runtime and analyzer understand it.

This work makes literal FHIRPath expressions carry their result type through the
full language wherever the required model and host declarations are known. The
most visible gain is deleting manual `type` assertions from ordinary shaping
code:

```ts
r4.project(patients, {
  name: "(Patient.name.family + ' ' + Patient.name.given.join(' ')).trim()",
  // Before: { path: "...", type: 'string' }
  // After: string | undefined
})

r4.evaluate('Patient.birthDate + 1 year', patient) // string[] (FHIR date)
r4.first('Patient.name.exists() and Patient.active', patient) // boolean | undefined
```

The gain is broader than operators:

- DTO fields such as `@column("code.text & ' (dx)'") value!: string` are
  checked against the expression without repeating `{ type: 'string' }`.
- A typed `%report` environment value keeps `%report.status`, comparisons, and
  later calls precise instead of entering an unknown region.
- A custom function's existing `signature` supplies its call result, so
  `code.displayText().trim()` stays `string[]`.
- A Reference path carries its generated target profiles through `resolve()`,
  so navigation after resolution can be inferred.
- `evaluate()`, `first()`, `compile()`, bound expressions, `project()` columns,
  and DTO decorators all improve together because they already consume
  `FhirpathResult` / `FhirpathResultIn`.

This remains result inference, not a second diagnostics system. Invalid,
over-budget, unsupported, or genuinely unknowable expressions degrade to
`unknown[]`; the analyzer, ESLint rule, and CLI continue to report mistakes.

## Baseline on current main

Since PR #15 was opened, `main` has already landed work that this plan must reuse:

- `FIXED_RETURNS` and `IDENTITY_RETURNS`, cross-checked against
  `FUNCTION_SIGNATURES`.
- Top-level and grouped `|` unions, `%var` roots, nested `select()` parsing, and
  guards against operators being swallowed as path segments.
- A 134-expression compiler-performance fixture and a checked-in instantiation
  budget (`25,872` at this plan's baseline).
- `analyzeExpressionDetailed()`, which exposes the analyzer's inferred candidate
  types and cardinality for use as the soundness oracle.
- Analyzer tracking for lambda states, variable scopes, reference targets,
  custom-function overloads, and result-dependent functions such as `select`,
  `union`, and `iif`.

The current segment walker remains deliberately incomplete. In particular,
operators are rejection signals rather than syntax, and function typing is split
between small handwritten tables. Extending those patterns to the whole grammar
would multiply quote-, parenthesis-, precedence-, and scoping-specific branches.
The implementation therefore replaces the walker after reaching parity; it does
not keep two inference implementations.

## Contract and scope

### Supported meaning of “full language”

The type layer parses every grammar form the runtime accepts and evaluates every
static rule the analyzer can express:

- empty, Boolean, Integer, Long, Decimal, String, Date, DateTime, Time, and
  Quantity literals
- unary operators; every arithmetic, string, collection, comparison, equality,
  membership, Boolean, and type operator
- navigation, choice stems, indexers, groups, calls, and all precedence levels
- built-in functions, including lazy/expression arguments
- `$this`, `$index`, `$total`, `defineVariable()`, and nested lambda frames
- `%context`, `%resource`, `%rootResource`, declared `%env`, and declared `%vars`
- generated R4 reference targets and `resolve()`
- declared native, expression-defined, overloaded, and DTO-registered functions
  to the extent their public declaration exposes a result

“Full” does not mean guessing data-dependent values. These inputs stay opaque:

- a non-literal `string` expression
- an expression over a model with no generated type maps (only R4 ships)
- an environment value, pre-resolved var, native host function, or external
  reference with no type declaration
- reflection or tree traversal whose result has no bounded static type
- a construct whose analyzer result is unknown
- an expression over the token budget

An opaque branch may become precise only through a rule whose result genuinely
does not depend on that branch, such as `count()` or a declared fixed-result host
function. An unknown branch must never be narrowed merely because a plausible
type would make the rest of the expression work.

### Soundness rule

For the same expression, R4 root, and declared context, type-level inference must
either:

1. normalize to the same candidate JS element types as
   `analyzeExpressionDetailed().result`, or
2. return `unknown[]`.

More-specific output than the analyzer is forbidden unless the analyzer is
upgraded in the same commit and the shared tests prove the new rule. Precision is
measured and ratcheted; it is not forced toward an arbitrary percentage by
inventing types.

## Public type declarations

Existing calls remain source compatible through default generics and optional
properties.

```ts
export interface FhirpathTypeDeclaration<
  Type extends FhirTypeName = FhirTypeName,
  Collection extends boolean = boolean,
> {
  /** One candidate type, or every candidate a value may hold. */
  type: Type | readonly Type[]
  /** Omitted means at most one item; true means the value may contain many. */
  collection?: Collection
  /** Resource targets when `type` includes Reference. */
  targets?: FhirTypeName | readonly FhirTypeName[]
}

export interface FhirpathTypeContext {
  env?: Readonly<Record<string, FhirpathTypeDeclaration>>
  vars?: Readonly<Record<string, FhirpathTypeDeclaration>>
  functions?: Readonly<Record<string, CustomFunction>>
}

export type FhirpathResult<
  Expr extends string,
  Context extends FhirpathTypeContext = {},
> = /* inferred collection */

export type FhirpathResultIn<
  Expr extends string,
  Input extends string,
  Context extends FhirpathTypeContext = {},
> = /* inferred collection */
```

`EvaluateOptions` and `EngineOptions` gain `envTypes` and `varTypes`, both maps of
`FhirpathTypeDeclaration`. Names normalize with or without their leading `%`, the
same as runtime values. The declarations are compile-time/analyzer contracts and
do not change evaluation values.

```ts
const fp = new FhirPathEngine({
  model: r4Model,
  env: { report, fallback: ['draft', 'unknown'] },
  envTypes: {
    report: { type: 'DiagnosticReport' },
    fallback: { type: 'string', collection: true },
  },
})

fp.evaluate('%report.status.combine(%fallback)', patient)
// string[]
```

`FhirPathEngine` captures one context generic inferred from its constructor.
Evaluate-family and projection methods merge per-call declarations into the
captured context by normalized name; per-call declarations win, matching runtime
`env`/`vars`/`functions` precedence. A function-local `envTypes` overlay wins for
the duration of an expression-defined function, matching its runtime `env`
overlay and the DTO-local precedence already documented in `AGENTS.md`.

`CustomFunctionSignature` accepts readonly `input.types` / `result.types` so a
literal signature remains narrow. The type layer normalizes local (`string`),
System (`System.String`), and FHIR (`FHIR.Patient`) spellings the same way as the
analyzer. A native function without a declared result is opaque. An
expression-defined function may use its declared result; if it has none, its
literal body is inferred against the call focus with recursion detection. An
overload resolves by declared input type exactly as the engine does; if several
candidates remain possible, their result states are widened together.

Expression-valued `vars` are inferred from their literal expression when their
dependencies are available. `varTypes` supplies the type of pre-resolved values
or intentionally overrides inference as a declaration. Overlapping env/var names
remain a runtime/analyzer error; result inference degrades that invalid context
rather than choosing a winner.

`CompiledExpression` and `BoundExpression` retain their explicit `TInput` and
`TResult` escape hatches. Their normal inference carries the captured engine
context and merges method-level options. The free exported result types accept a
context explicitly for hosts building wrappers.

## Type-level architecture

### Tokenizer and budget

Implement a template-literal tokenizer with a token accumulator and an explicit
step counter. It recognizes the runtime lexer's complete vocabulary, including
comments, delimited identifiers, escaped strings, temporal/quantity literals,
multi-character operators, and word operators.

The hard cap is **64 semantic tokens** after comments and whitespace. A baseline
audit of the vendored official R4/R5 suites and runnable fhirpath.js suites finds
2,356 distinct expressions. The runtime parser accepts 2,348; 2,347 of those
(99.6% of the combined runnable inventory) fit within 64 tokens. The remaining
accepted expression has 208 tokens. Token 65 returns the opaque sentinel
immediately. That long expression is an intentional budget-bail case, and the
eight runtime-parser rejections are classified as invalid or unsupported corpus
syntax rather than silently omitted.

Every loop is directly tail-recursive. Conditionals that inspect union-bearing
state use tuple guards (`[T] extends [U]`) unless distribution is explicitly the
operation. Malformed tokens, unmatched delimiters, unfinished expressions, and
depth exhaustion all return opaque rather than a compiler error.

### Parser shape and prior art

The production parser is a cursor-driven shift-reduce state machine. It follows
the strongest transferable part of
[ArkType's parser](https://github.com/arktypeio/arktype/blob/03b1f015d9b7c5af5dac2caed1aeedefaf705ab3/ark/type/parser/string.ts):
the runtime and type-level implementations use the same state vocabulary, token
metadata, and finalizers; a single tail-recursive loop alternates between operand
and operator work; group state is explicit; and only measured common forms get a
fast path. Token/operator tables are generated from the runtime implementation so
the two parsers cannot acquire separate spellings or precedence.

ArkType's fixed `intersection`/`union`/`pipe` branch slots do not scale to
FHIRPath's 13 precedence levels. FHIRPath therefore uses a general operator stack
and the runtime precedence table. It also returns an opaque sentinel instead of
carrying ArkType-style diagnostics and completions through the type system.

[ts-sql's parser](https://github.com/codemix/ts-sql/blob/de9dc91a30a0ce9340bed719ba6c0d564504ea56/src/Parser.ts)
is useful only as a small reference for the `[parsed, rest]` convention used by
isolated scanner helpers. Its whitespace/delimiter tokenizer, recursive-descent
union alternatives, and template match for parenthesized expressions do not
handle FHIRPath's nested groups, quoted delimiters, or compiler budget safely and
are not the production architecture.

Commit 1 includes a disposable measured spike over the common-path fixture and a
corpus-derived grammar stress fixture. It compares direct parse-and-infer state
with a compact AST followed by an inference pass. The default is the fused form
below; the AST form may replace it only if it stays within 15% of fused
instantiations on both fixtures, has no expression over the 100,000-instantiation
per-case ceiling, and demonstrably removes duplicated parser/semantic branches.
The chosen measurements and decision are recorded in this document's Amendments
before the full parser lands.

### Fused precedence and inference

Use one shift-reduce loop with explicit operand, operator, call, and scope stacks.
Its precedence table is generated from the runtime parser's operator metadata.
Reduction produces the inference state directly; no type-level AST is retained.
This is the planned default because it avoids paying once to construct an AST
type and again to walk it; the bounded Commit 1 comparison above can overturn
that choice with evidence.

The state carries:

```ts
interface InferenceState {
  types: string | undefined      // union of canonical names
  single: boolean | undefined    // at most one / may be many / unknown
  targets: string | undefined    // Reference target union
  rawInput: boolean
}
```

Type aliases encode this shape as compact tuples internally to reduce
instantiations. Object form above is explanatory only.

Calls push an argument frame. Lambda arguments evaluate with the focus item as
`$this`; `aggregate` also threads `$total`; nested frames restore the outer
bindings. `defineVariable` updates only the current expression chain, while
operator operands and function arguments fork the scope, matching the runtime
and analyzer.

### One source for static rules

Replace built-in result callbacks as the only semantic description with a small
declarative result-rule algebra capable of expressing:

- fixed result type/cardinality
- input-preserving or input-item result
- a selected argument's state
- input/argument unions with explicit cardinality
- type-target narrowing (`as`, `ofType`, `is`)
- Reference target resolution
- deliberately unknown result

The analyzer interprets those rules. A generator emits only the compact function
and operator records required by the type layer. Complex model compatibility
continues to live in the shared type-compatibility helpers; generated R4 maps add
the target and descendant unions the type layer needs.

Built-in registration, analyzer signatures, generated type rules, and the
capability tests are cross-checked by name. A function or operator cannot silently
exist in only one layer.

## Required capability tests

The implementation PR must demonstrate **every new inference capability it
claims**. A capability is not supported until its tests land in the same commit.

### Checked-in capability registry

Add a checked-in registry whose entries contain:

- a stable capability id and family
- either a stable vendored-corpus case id or an inline expression for a proven
  corpus gap
- optional input/context declarations that the source corpus cannot carry
- the exact expected public TypeScript result
- whether a stable runtime value is asserted
- the analyzer state expected after canonicalization
- the expected opaque/degradation companion case

A generator resolves corpus ids to the expression, resource fixture, expected
runtime result, and analyzer oracle directly from the vendored JSON. Expressions
are not copied into a second hand-maintained fixture. Human-readable
`expectTypeOf` tests consume the resolved registry. A hygiene test compares it
with literal kinds, operator metadata, built-in function rules, scope forms, and
dynamic-context declaration forms. CI fails if a precise rule lacks at least one
capability entry, if an id is duplicated, if an id stops resolving, or if an
entry no longer exercises the named rule.

Every capability entry must prove:

1. exact positive inference (`expectTypeOf`)
2. safe degradation for an ambiguous, invalid, unsigned, or over-budget variant
3. normalized agreement with `analyzeExpressionDetailed()`
4. runtime agreement when a deterministic fixture can evaluate it
5. downstream composition, showing its result feeds a following navigation,
   operator, or call correctly

### Exhaustive families

The registry and its hygiene tests cover:

- every literal kind: empty, Boolean, Integer, Long, Decimal, String, Date,
  DateTime, Time, Quantity
- unary `+` and `-`
- every runtime binary/type operator: `*`, `/`, `div`, `mod`, `+`, `-`, `&`,
  `is`, `as`, `|`, comparisons, equality/equivalence, `in`, `contains`, `and`,
  `xor`, `or`, and `implies`
- navigation, root/type identifiers, choices, indexers, grouping, call chaining,
  and every adjacent precedence boundary
- every built-in with a precise rule, including its result-dependent case
- every deliberately opaque built-in, proving it stays `unknown[]`
- `where`, `select`, `all`, criteria `exists`, `repeat`, `aggregate`, `sort`,
  `iif`, `defineVariable`, `$this`, `$index`, and `$total`, including nested frame
  restoration and branch-local variable scope
- `%context`, `%resource`, `%rootResource`, built-in constants, typed env, typed
  vars, inferred expression vars, and missing declarations
- native functions, expression-defined functions, overload selection, ambiguous
  overload widening, recursion bail, function-local env overlays, DTO-declared
  functions, and per-call/engine precedence
- generated and declared Reference targets, `resolve()`, and navigation after it
- comments, whitespace, escaped strings, literal delimiter characters,
  delimited identifiers, malformed syntax, incomplete calls, and tokens 64/65
- every behavior already supported by the current subset, unchanged at the
  parser-parity commit

Adding a built-in, operator, literal rule, or declaration form later requires a
registry entry in the same change. This makes “all supported capabilities are
tested” an executable invariant rather than a review convention.

### Reference-derived full-language fixture

The reference suites are the primary expression inventory, not a second layer of
tests beside a hand-written “full-language” list. The baseline audit finds:

- 2,356 distinct expressions across valid official R4/R5 cases and runnable
  fhirpath.js cases
- 2,348 expressions accepted by the current runtime parser
- 2,347 accepted expressions at or below the 64-token type-level budget (99.6%
  of the combined inventory)
- every runtime operator and every literal AST kind represented
- 113 of 114 signed built-ins represented in runnable cases; `convertsToLong`
  appears in vendored skipped cases, so it can still supply the expression for a
  dedicated type assertion without claiming runtime agreement

This means the grammar, literal, operator, and built-in-call fixture can be
derived entirely from the references at baseline. The 99.6% figure is budget
coverage of the runnable expression inventory, not a claim that the references
can express host API contracts. Commit 1 checks in the audit script and its
summary so these numbers are reproducible and drift is visible.

Hand-written expressions are allowed only where the reference formats cannot
state the contract being tested:

- any future grammar/rule entry absent even from skipped reference cases
- exact public API shapes for `evaluate`, `first`, compiled/bound expressions,
  projections, and DTO field checking
- typed env, vars, native/expression functions, overloads, local overlays, and
  other host declarations absent from the reference suites
- analyzer-opaque/degradation companions, the 64/65-token boundary, and focused
  downstream-composition cases not present in the corpus
- adversarial compiler-budget cases

The generated capability index tags each corpus expression with every construct
it exercises. A capability entry references the smallest case whose analyzer
result is precise enough for its exact positive assertion; one case may cover
several constructs, but each construct still has its own capability id and
expected public type. The checked-in summary reports both corpus-backed and
hand-written capability counts, preventing a quiet return to duplicated fixtures.

### Corpus soundness and precision ratchet

A script generates temporary TypeScript assertion shards from both official
suites and both fhirpath.js JSON corpora. For each usable expression it:

1. derives the R4 input type and applicable declarations
2. calls `analyzeExpressionDetailed()` to obtain the oracle state
3. emits an assertion accepting analyzer agreement or `unknown[]`, never a
   narrower disagreement
4. invokes `tsc` on bounded shards so one file cannot dominate the compiler

Invalid expressions assert opaque. The accepted 208-token expression asserts
budget bail. Runtime-parser rejections, R5-model-only cases, DSL objects, and
unavailable-context cases are classified in the report rather than being
mistaken for inference failures.

Check in a generated precision summary grouped by literals, paths, operator
family, function family, lambdas, variables, dynamic declarations, resolve, and
bail reason. It also records corpus totals, parse rejection reasons, token-budget
coverage, and the signed-function/operator coverage matrix quoted above. CI fails
when a previously precise case becomes opaque or changes to a conflicting type.
No arbitrary precision percentage can override soundness.

## Performance gates

Extend the existing deterministic instantiation check rather than create a
parallel timing system:

- Preserve a common-path fixture and keep it within **10%** of the current
  `25,872`-instantiation baseline.
- Generate the representative full-language fixture from the capability index:
  at least one case per syntax/rule family, every adjacent precedence boundary,
  the longest accepted case under the cap, and the highest-cost nested
  lambda/scope cases. Keep the whole fixture below **5,000,000** instantiations;
  do not maintain another copied expression list.
- Compile the most expensive registered capability expressions independently;
  none may exceed **100,000** instantiations.
- Record memory/check-time diagnostics in the implementation PR, but gate on
  deterministic instantiation counts.
- Run the performance fixture on the lockfile TypeScript and the previous minor
  in CI. Each version has its own checked-in baseline because instantiation
  accounting changes between compilers.
- Any budget increase must be in the same commit as the capability that needs it
  and explained in the PR description, per `AGENTS.md`.

### Runtime cross-engine benchmark

Run the existing [`benchmarks/`](https://github.com/vintasoftware/fhirpath-ts/tree/main/benchmarks)
harness before Commit 1 and again after Commit 6. It evaluates the same 821
official R4 expression/resource pairs in fhirpath-ts with the R4 model,
fhirpath-ts without a model, and the Rust `octofhir-fhirpath` engine with its
empty model provider. Keep the Rust dependency pinned to `0.4.50` for the two
runs unless a separate documented compatibility fix is required.

For each baseline and final measurement:

- record the fhirpath-ts commit, Rust harness/crate version, Node, TypeScript,
  rustc/cargo, CPU, OS, and common accepted-case count
- run the full harness five times on the same idle machine and compare the median
  of the aggregate, median, and p95 parse/evaluation results
- publish the before/after table in the implementation PR and attach or link the
  raw generated JSON; keep machine-specific `benchmarks/results/` git-ignored
- investigate any fhirpath-ts regression over **15%** in the five-run median on
  the unchanged common accepted set; explain an accepted-set change separately

The Rust number is comparative context, not an acceptance target: different
model providers make the model-aware result intentionally asymmetric. The
before/after fhirpath-ts result catches runtime regressions from shared rule or
signature refactors. It does not measure type-level cost and cannot replace the
deterministic TypeScript instantiation gates above.

## One-PR implementation sequence

The implementation is one branch and one PR. Each phase is a reviewable commit;
all earlier tests and applicable repository gates are green at every commit.

### Commit 1 — Harness and shared rule algebra

- Add the corpus-derived capability index/registry, audit and hygiene checks,
  assertion generator, precision report, and split performance fixtures.
- Measure the fused-state/compact-AST parser spike, record the architecture
  decision in Amendments, and delete the losing spike.
- Run and record the five-run runtime/Rust benchmark baseline on the current-main
  commit and pinned toolchains.
- Introduce the declarative function/operator result rules and make the analyzer
  interpret them without changing diagnostics or current inferred results.
- Record baselines for the existing subset.

### Commit 2 — Tokenizer/parser parity

- Add the 64-token tokenizer and the selected shift-reduce parser for paths,
  indexers, existing calls, `select()` subexpressions, unions, groups, and `%var`
  roots.
- Pass all existing inference and capability tests unchanged.
- Delete `ParseSegments`, `StepAcrossParen`, the glued-segment scanner, and other
  superseded parsing machinery. There is one type-level parser after this commit.

### Commit 3 — Literals and operators

- Implement every literal and unary/binary/type operator rule.
- Land every operator/literal capability entry, degradation case, downstream
  composition case, runtime agreement, and precedence-boundary test.
- Make the motivating projection infer `string` without an annotation.

### Commit 4 — Calls, lambdas, variables, and references

- Interpret every precise built-in result rule and explicit opaque rule.
- Implement lambda frames, lazy branches, `defineVariable`, `$this/$index/$total`,
  generated reference targets, and `resolve()`.
- Land one registry entry for every built-in and scope form, enforced by hygiene
  checks.

### Commit 5 — Typed host context

- Add the public type declarations and engine/per-call context generics.
- Infer declared env, vars, native/expression functions, overloads, local
  overlays, and registered DTO functions whose declarations are visible.
- Test every merge/precedence route and confirm old untyped calls retain their
  existing types.

### Commit 6 — Ratchet, documentation, and generated declarations

- Run and check in the final corpus precision report and budgets.
- Rerun the five-run cross-engine benchmark on the same machine and publish the
  before/after fhirpath-ts and contextual Rust comparison in the PR description.
- Update README examples to remove annotations inference now makes redundant,
  while retaining the manual escape hatches for opaque cases.
- Regenerate demo declarations and document typed dynamic contexts.
- Ensure the implementation PR description contains the generated capability
  table: capability id, construct, before type, after type, and test location.

## Acceptance gates

The implementation is complete only when:

- the motivating projection and every expression advertised as newly supported
  have exact capability-registry tests
- capability hygiene reports no untested literal, operator, precise function,
  scope form, or configuration route
- the generated full-language fixture still resolves from the vendored suites,
  covers every runtime operator and signed built-in (with an explicit local gap
  assertion for a skipped source case where needed), and reports its
  corpus-backed/manual split
- the generated corpus soundness sweep has no narrower-than-analyzer result
- the precision report has no unexplained regression from its prior commit
- the 64-token bail and all intentional opaque rules are tested
- existing public inference tests pass unchanged at parity and remain green
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm check:fhirpath`,
  `pnpm check:type-perf`, and `pnpm coverage` pass
- the demo's declarations are regenerated and its typecheck/build pass
- the before/after TypeScript and five-run cross-engine benchmark tables are in
  the PR, with every regression over the stated thresholds resolved or explained
- no runtime dependency is added

## Risks

| Risk | Mitigation |
| --- | --- |
| TypeScript instantiation blowup | 64-token hard bail, tail recursion, compact tuple state, common/worst-case budgets |
| Plausible but wrong types | Analyzer-or-unknown corpus oracle; capability degradation and downstream tests |
| Function/analyzer drift | Declarative result rules, generated type table, name-level hygiene tests |
| Reference fixtures duplicate instead of replace hand-written cases | Registry stores corpus ids; generated index and corpus/manual count are checked |
| Parser prior art does not fit FHIRPath | Measured fused/AST spike, general precedence stack, explicit documented decision before implementation |
| Scoping differs from runtime | Capability cases for nested frames, forked operands/arguments, variable lifetime, and local overlays |
| Shared-rule refactor slows runtime | Same-machine five-run before/after benchmark plus contextual pinned Rust comparison |
| Typed host declarations overpromise actual values | Declarations constrain supplied TypeScript values where possible; unsigned/dynamic data stays opaque |
| One implementation PR becomes hard to review | Six ordered green commits, generated capability summary, and explicit budget/precision diffs per commit |

## Amendments

*(none yet)*
