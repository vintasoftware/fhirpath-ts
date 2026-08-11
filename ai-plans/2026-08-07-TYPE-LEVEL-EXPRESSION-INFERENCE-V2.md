# Full type-level FHIRPath inference from current main

> Status: **plan only, not scheduled**. This replaces PR #15's July plan with a
> design based on current `main`. The implementation is one PR, split into green
> commits in the order below. Keep this document current through its Amendments
> section once implementation starts. Revalidated against `main` at `c678abc`
> on 2026-08-10.

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
- User-facing API documentation now lives in `docs/api.md`, while
  `src/documentation.test.ts` keeps its examples tied to executable recipes.
  The demo has its own editor-sample test in addition to declaration generation,
  typechecking, and building.

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
- declared native, expression-defined, and overloaded custom functions when
  their public declaration exposes a result

“Full” does not mean guessing data-dependent values. These inputs stay opaque:

- a non-literal `string` expression
- an expression over a model with no generated type maps (only R4 ships)
- an environment value, pre-resolved var, native host function, or external
  reference with no type declaration
- a function synthesized from standard DTO field decorators: decorators do not
  add their column names or options to the class's static TypeScript type, so
  `resourceDtos` alone cannot expose those functions soundly to the type layer
- reflection or tree traversal whose result has no bounded static type
- a construct whose analyzer result is unknown
- an expression over either scanner budget

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

`FhirPathEngine` gains a defaulted context generic. Its constructor and every
method-level options argument preserve a concrete context with `const` generic
inference, then normalize and merge those maps by key. Direct object literals,
`as const satisfies` declarations, and literal-typed compiled function bodies
retain their declarations. A value already widened to plain `EngineOptions`,
`EvaluateOptions`, or `CustomFunction` has intentionally lost those literals and
degrades where they were needed; the implementation must not pretend to recover
them. Add a small identity helper only if the Commit 5 API spike proves that
ordinary reusable declarations otherwise widen in realistic calls.

`EvaluateOptions` and `EngineOptions` gain `envTypes` and `varTypes`, both maps of
`FhirpathTypeDeclaration`. Names normalize with or without their leading `%`, the
same as runtime values. The declarations are compile-time/analyzer contracts and
do not change evaluation values. Where a declaration and its corresponding
`env`/pre-resolved `vars` value are both visible in one literal options object,
the generic API constrains that value to the declared element type and
cardinality. Separately supplied or already widened values remain an explicit
host contract.

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
`env`/`vars`/`functions` precedence. The expression-defined branch of
`SingleCustomFunction` also gains `envTypes`; that function-local overlay wins
for the duration of its body, matching its runtime `env` overlay and the
DTO-local precedence already documented in `AGENTS.md`.

Projection inference also injects `%rowIndex` and `%rowTotal` as single Integers,
because `project()` replaces caller values for those names at runtime. Root-aware
APIs use `FhirpathResultIn`: an explicit `inputType`, a DTO's `fhirType`, or a
resource input's literal `resourceType` can supply `%context`, `%resource`, and
`%rootResource`. A structurally typed datatype or ambiguous Bundle input does not
get reverse-mapped to a guessed FHIR name; it needs an explicit input type or
stays opaque.

Every array in `CustomFunctionSignature` accepts readonly input, including
`input.types`, `args`, and `result.types`, so a literal signature remains narrow.
The type layer normalizes local (`string`), System (`System.String`), and FHIR
(`FHIR.Patient`) spellings the same way as the analyzer. A native function
without a declared result is opaque. An expression-defined function may use its
declared result; if it has none, its literal body is inferred against the call
focus with recursion detection. An overload resolves by declared input type
exactly as the engine does; if several candidates remain possible, their result
states are widened together.

Expression-valued `vars` are inferred from their literal expression when their
dependencies are available. `varTypes` supplies the type of pre-resolved values
or intentionally overrides inference as a declaration. Overlapping env/var names
remain a runtime/analyzer error; result inference degrades that invalid context
rather than choosing a winner.

`CompiledExpression` retains its existing explicit `TInput` and `TResult` escape
hatches. Its default-result path must use a distinguishable internal sentinel (or
an equivalently proven overload design), so method-level options can still refine
the result while an explicitly supplied third generic always wins.
`BoundExpression` has no independent `TInput`/`TResult` escape hatches today; it
gains only the captured engine-context generic and merges method-level options.
The free exported result types accept a context explicitly for hosts building
wrappers. Commit 5 must lock all of these call shapes with exact public API tests
before migrating internal callers.

DTO field decorators still benefit from every new grammar and result rule that
depends only on the expression and `fhirType`. They do not automatically publish
decorated column metadata into `resourceDtos`' static class type. Registered DTO
function calls therefore remain analyzer-checked but opaque to
`FhirpathResult` unless a future API supplies explicit, cross-checked static
metadata. Inferring every non-method instance property would incorrectly include
ordinary fields and getters, so it is forbidden as an approximation.

## Type-level architecture

### Tokenizer and budget

Implement a template-literal tokenizer with a token accumulator and explicit
semantic-token and source-scan counters. It recognizes the runtime lexer's
complete vocabulary, including comments, delimited identifiers, escaped strings,
temporal/quantity literals, multi-character operators, and word operators.

The hard caps are **64 semantic tokens** after comments and whitespace and **256
source-scanner steps**. A baseline audit of the vendored official R4/R5 suites
and runnable fhirpath.js suites finds 2,356 distinct expressions. The runtime
parser accepts 2,348; 2,347 of those (99.6% of the combined runnable inventory)
fit within 64 tokens. Every one of those 2,347 expressions is at most 255 source
code units. The remaining accepted expression has 208 tokens. Token 65 or source
step 257 returns the opaque sentinel immediately. The second cap prevents a huge
comment, identifier, or one-token string literal from bypassing the semantic
token budget. The long expression is an intentional budget-bail case, and the
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

### FHIRPath implementation survey

The survey snapshot is 2026-08-07. GitHub stars are used to find widely used
implementations, not as a correctness score: monorepo stars include much more
than their FHIRPath parser, and repository search also returns applications that
only call a parser. The five inspected implementation families balance stars,
FHIR ecosystem authority, an existing mention in this repository, and parser
architecture. The Rust implementation wins the final slot over another
ANTLR-based Python implementation because it is this repository's performance
comparator and adds a distinct parser design.

| Implementation | Why inspected | Parser shape | What this plan takes |
| --- | --- | --- | --- |
| [Medplum](https://github.com/medplum/medplum/blob/6924211c3d913bffcb11ad5e7b8cefaef6705cb6/packages/core/src/fhirpath/parse.ts) (about 2.6k stars) | Most-starred repository with a directly inspectable FHIRPath implementation; current `src/parser/parser.ts` already credits its parser core | Token array plus a table-driven Pratt `ParserBuilder` with registered prefix/infix parselets | A generated parselet classification table and one cursor loop; not its recursive runtime control flow |
| [Firely .NET SDK](https://github.com/FirelyTeam/firely-net-sdk/blob/792b6cfd855060bfedaf6527542ff53d0f08cb0f/src/Hl7.Fhir.Base/FhirPath/Parser/Grammar.cs) (about 930 stars) | Widely used SDK implementation | Parser combinators, one explicit parser per precedence level, chained left-associative operators | Explicit RHS modes: expression, type specifier, call arguments, and index expression; keyword boundary tests |
| [HAPI/HL7 core](https://github.com/hapifhir/org.hl7.fhir.core/blob/b3349f4e8013af8e7e6f2c838c2d8b22e0d20496/org.hl7.fhir.r5/src/main/java/org/hl7/fhir/r5/fhirpath/FHIRPathEngine.java) (about 200 stars for the implementation repository) | Java reference engine used by HAPI and the HL7 validator | Parses a flat operator chain, then repeatedly groups it by precedence; validates calls while parsing | A concrete two-pass AST candidate for the Commit 1 spike only; its regrouping pass and parse-time diagnostics do not enter production types |
| [fhirpath.js](https://github.com/HL7/fhirpath.js/blob/e1e4586a1f6d389be73ca68e85e83464c9024406/src/parser/FHIRPath.g4) (about 184 stars) | Required JS reference and source of a vendored test corpus | ANTLR left-recursive grammar, hidden trivia channel, full-input `EOF`, then a listener-built AST | Its vendored corpus as the executable syntax oracle, plus semantic-token and trailing-token cases; no generated ANTLR parse tree in the type layer |
| [octofhir fhirpath-rs](https://github.com/octofhir/fhirpath-rs/blob/572e375a472ac8f9eaaa045e9fbf9ae6bd3c924b/crates/octofhir-fhirpath/src/parser/pratt.rs) (about 23 stars) | Performance-focused implementation already used by `benchmarks/` | Chumsky Pratt parser split into prefix/postfix and precedence layers, with separate fast and diagnostic modes | Prefix/infix/postfix reducer categories and fail-fast opaque behavior; not its library-driven layer split or duplicated fast/analysis grammar |

The additional
[fhirpath-py grammar](https://github.com/beda-software/fhirpath-py/blob/41de3574e6586d8a9ad13b5246325e89ed3f7ec8/fhirpathpy/parser/FHIRPath.g4)
(about 75 stars) was inspected as a check. It is another ANTLR grammar/listener
pipeline and adds no useful type-level parser technique. Its grammar has already
diverged from fhirpath.js in type-operator precedence and newer literal/sort/
instance-selector forms. That is useful negative evidence: do not copy a second
grammar into the type system.

ArkType remains the primary architecture reference because it alone solves the
hard part specific to this work: parsing inside TypeScript's conditional-type
evaluator. The FHIRPath implementations refine domain details but do not change
that choice.

The resulting generated parselet record contains token kind, fixity, binding
power, associativity, RHS mode, and reducer id. Both the runtime metadata parity
test and the type-level loop consume that record. `is`/`as` consume a qualified
type specifier rather than a general expression; calls and indexers push their
own delimiter frames; word operators are accepted only as whole tokens. A corpus
hygiene test maps every runtime parselet and classifies fhirpath.js-only syntax
encountered in the vendored corpus as an explicit divergence. External
implementations remain research inputs and add no dependency or generated source
to this package.

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
Its parselet records and precedence table are generated from the runtime parser's
operator metadata. Reduction produces the inference state directly; no type-level
AST is retained. This is the planned default because it avoids paying once to
construct an AST type and again to walk it; the bounded Commit 1 comparison above
can overturn that choice with evidence.

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
  overload widening, recursion bail, function-local env overlays, and
  per-call/engine precedence
- registered DTO functions as an explicit opaque boundary in type-level tests,
  while loaded DTO/analyzer tests continue to prove their declarations and
  dispatch
- generated and declared Reference targets, `resolve()`, and navigation after it
- comments, whitespace, escaped strings, literal delimiter characters,
  delimited identifiers, malformed syntax, incomplete calls, tokens 64/65, and
  source-scan steps 256/257
- `%rowIndex` and `%rowTotal` in projections, including their precedence over
  same-named caller declarations
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
- 2,347 accepted expressions at or below both type-level scanner budgets (99.6%
  of the combined inventory): at most 64 semantic tokens and 255 source code
  units
- every runtime operator and every literal AST kind represented
- 113 of 114 signed built-ins represented in runnable cases; `convertsToLong`
  appears in vendored skipped cases, so it can still supply the expression for a
  dedicated type assertion without claiming runtime agreement

This means the grammar, literal, operator, and built-in-call fixture can be
derived entirely from the references at baseline. The 99.6% figure is coverage
under both scanner budgets for the runnable expression inventory, not a claim
that the references can express host API contracts. Commit 1 checks in the audit
script and its summary so these numbers are reproducible and drift is visible.

Hand-written expressions are allowed only where the reference formats cannot
state the contract being tested:

- any future grammar/rule entry absent even from skipped reference cases
- exact public API shapes for `evaluate`, `first`, compiled/bound expressions,
  projections, and DTO field checking
- typed env, vars, native/expression functions, overloads, local overlays, and
  other host declarations absent from the reference suites
- analyzer-opaque/degradation companions, the 64/65-token and 256/257-source-step
  boundaries, and focused downstream-composition cases not present in the corpus
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

- Preserve the common-path fixture and keep each implementation-phase baseline
  within the checked-in **5%** ratchet. The initial `25,872` baseline and the
  production-parser correction are recorded in Amendments.
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

Commit 1 is a go/no-go gate. Continue only if at least one measured parser design
can meet the common-path, representative-fixture, and per-case ceilings without
weakening soundness or either scanner cap. If neither design fits, record the
measurements and amend or stop the implementation PR; do not turn a failed spike
into an unexplained budget increase.

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
- Add the generated parselet-record schema, runtime-metadata parity check, and
  vendored-corpus syntax support/divergence report before implementing new syntax.
- Measure the fused-state/compact-AST parser spike, record the architecture
  decision and go/no-go result in Amendments, and delete the losing spike.
- Run and record the five-run runtime/Rust benchmark baseline on the current-main
  commit and pinned toolchains.
- Introduce the declarative function/operator result rules and make the analyzer
  interpret them without changing diagnostics or current inferred results.
- Record baselines for the existing subset.

### Commit 2 — Tokenizer/parser parity

- Add the 64-token tokenizer and the selected shift-reduce parser for paths,
  indexers, existing calls, `select()` subexpressions, unions, groups, and `%var`
  roots.
- Enforce the independent 256-step source scan cap while tokenizing trivia,
  quoted values, and identifiers.
- Drive prefix/infix/postfix dispatch, precedence, associativity, and RHS mode
  from the generated parselet records.
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
  overlays, projection row variables, and root-aware built-ins.
- Keep functions synthesized only from `resourceDtos` opaque in the type layer;
  retain their loaded analyzer checks and runtime dispatch tests.
- Test literal capture, deliberately widened declarations, every merge/precedence
  route, the `CompiledExpression` result override, and old untyped calls.

### Commit 6 — Ratchet, documentation, and generated declarations

- Run and check in the final corpus precision report and budgets.
- Rerun the five-run cross-engine benchmark on the same machine and publish the
  before/after fhirpath-ts and contextual Rust comparison in the PR description.
- Update `docs/api.md` for the public context API and `README.md` examples to
  remove annotations inference now makes redundant, while retaining the manual
  escape hatches for opaque cases. Keep `src/documentation.test.ts` and its
  executable recipe coverage in sync.
- Regenerate demo declarations, update any affected playground examples, and run
  the demo's editor-sample test as well as its typecheck and build.
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
- every syntax form encountered in the vendored fhirpath.js corpus is mapped to
  current runtime support or an explicit divergence, and runtime/type-level
  parselet metadata agrees
- the generated corpus soundness sweep has no narrower-than-analyzer result
- the precision report has no unexplained regression from its prior commit
- the 64-token and 256-source-step bails and all intentional opaque rules are
  tested
- existing public inference tests pass unchanged at parity and remain green
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm check:fhirpath`,
  `pnpm check:type-perf`, and `pnpm coverage` pass
- `src/documentation.test.ts` covers the changed README/API examples
- the demo's declarations are regenerated and its editor-sample test,
  typecheck, and build pass
- the before/after TypeScript and five-run cross-engine benchmark tables are in
  the PR, with every regression over the stated thresholds resolved or explained
- no runtime dependency is added

## Risks

| Risk | Mitigation |
| --- | --- |
| TypeScript instantiation blowup | 64-token hard bail, tail recursion, compact tuple state, common/worst-case budgets |
| Huge trivia or one-token literals bypass the token cap | Independent 256-step source scan cap with 256/257 boundary tests |
| Plausible but wrong types | Analyzer-or-unknown corpus oracle; capability degradation and downstream tests |
| Function/analyzer drift | Declarative result rules, generated type table, name-level hygiene tests |
| Reference fixtures duplicate instead of replace hand-written cases | Registry stores corpus ids; generated index and corpus/manual count are checked |
| A copied reference grammar drifts from this runtime | Generated parselet records come from runtime metadata; fhirpath.js alternatives have an explicit support/divergence audit |
| Parser prior art does not fit FHIRPath | Measured fused/AST spike, general precedence stack, explicit documented decision before implementation |
| Scoping differs from runtime | Capability cases for nested frames, forked operands/arguments, variable lifetime, and local overlays |
| Context literals widen before inference | Const-generic capture tests, documented `as const satisfies` path, opaque fallback after deliberate widening |
| DTO decorators appear statically enumerable when they are not | Keep `resourceDtos`-synthesized calls opaque; rely on loaded analyzer checks rather than guessing from instance fields |
| Shared-rule refactor slows runtime | Same-machine five-run before/after benchmark plus contextual pinned Rust comparison |
| Typed host declarations overpromise actual values | Declarations constrain supplied TypeScript values where possible; unsigned/dynamic data stays opaque |
| One implementation PR becomes hard to review | Six ordered green commits, generated capability summary, and explicit budget/precision diffs per commit |

## Amendments

### 2026-08-10 — current-main revalidation

- Rebased the plan over `main` at `c678abc` and reviewed the current analyzer,
  engine/options merge paths, DTO registration, projection row context, parser
  metadata, documentation tests, and demo CI.
- Reproduced the corpus claims from the checked-in R4/R5 and fhirpath.js data:
  2,356 distinct expressions, 2,348 accepted by the runtime parser, 2,347 at or
  below 64 semantic tokens, one accepted 208-token bail case, every runtime
  operator/literal kind, and 113 of 114 signed built-ins (`convertsToLong` is the
  gap).
- Added the independent 256-step scanner cap after confirming that the longest
  accepted expression under the semantic-token cap is 255 source code units.
- Corrected the public-context plan around literal widening, input-root flow,
  `CompiledExpression` versus `BoundExpression`, projection row variables, and
  the fact that standard DTO decorators do not expose registered column metadata
  to TypeScript.
- Updated the delivery gates for the current documentation split and demo
  editor-sample test, and made Commit 1 an explicit go/no-go performance gate.

### 2026-08-10 — Commit 1 measurements and parser decision

- Started implementation from merged `main` at `1730ab6`. The Rust manifest's
  `"0.4.50"` requirement admitted 0.4.53 through Cargo's caret semantics, so the
  harness now uses `"=0.4.50"`; the baseline below was rebuilt and verified
  against octofhir-fhirpath 0.4.50.
- Reproduced the corpus inventory in a generated audit: 4,190 raw cases, 2,356
  distinct expressions, 2,348 runtime-parser acceptances, 2,347 expressions at
  or below 64 semantic tokens, and one accepted 208-token budget case. The audit
  covers every runtime literal and operator and 113 of 114 signed built-ins;
  `convertsToLong` remains the explicit source gap.
- Measured disposable forced-evaluation parser spikes with TypeScript 5.9.3.
  On the common-path spike fixture, fused state used 7,852 instantiations and a
  compact AST used 9,763 (+24.3%). On the grammar-stress fixture, fused state
  used 24,547 and a compact AST used 28,901 (+17.7%). Both were below the hard
  ceilings, but the AST design missed the 15% replacement threshold in both
  fixtures. The implementation therefore proceeds with one bounded fused-state
  shift-reduce parser; both disposable spikes were deleted.
- Recorded deterministic baselines for both pinned compiler lanes. TypeScript
  5.9.3 uses 25,872 common-path instantiations before the refactor and 7,383 for
  the generated full-language fixture; the Commit 1 common path is 26,639
  (+3.0%). TypeScript 5.8.3 uses 27,054 and 7,398 respectively. The worst
  independently compiled registered case is 4,685/4,691 instantiations, well
  below the 100,000 ceiling.
- The first generated soundness sweep reported three narrower-than-analyzer
  baseline cases: incompatible `as`/`ofType` narrowing and `toQuantity()` using
  the FHIR Quantity shape for a System Quantity. Commit 1 now degrades the two
  incompatible narrowing cases to opaque and adds the correct System Quantity
  public shape. The checked-in baseline is 302 precise, 2,045 opaque, and zero
  conflicts across the 2,347 in-budget accepted expressions.
- Ran the cross-engine harness five times on an idle Intel Core i7-10750H host
  running Ubuntu 22.04.5, Linux 6.8.0, Node 24.14.1, TypeScript 5.9.3, and
  rustc/cargo 1.96.0. All five runs had the same 809-case common accepted set
  after excluding trace cases. Values below are the median across runs of each
  run's aggregate mean, median, and p95:

| Engine | Metric | Median aggregate mean | Median | p95 |
| --- | --- | ---: | ---: | ---: |
| fhirpath-ts (R4 model) | Evaluation | 6.58 µs | 1.92 µs | 8.49 µs |
| fhirpath-ts (R4 model) | Parse | 1.16 µs | 1.01 µs | 2.18 µs |
| fhirpath-ts (no model) | Evaluation | 3.38 µs | 1.76 µs | 5.79 µs |
| fhirpath-ts (no model) | Parse | 1.17 µs | 1.01 µs | 2.20 µs |
| fhirpath-rs (octofhir 0.4.50) | Evaluation | 3.84 µs | 761 ns | 13.62 µs |
| fhirpath-rs (octofhir 0.4.50) | Parse | 6.28 µs | 5.42 µs | 12.35 µs |

The raw baseline JSON is retained outside the worktree under
`/tmp/fhirpath-type-inference-benchmarks/baseline/`; the reusable summarizer is
checked in under `benchmarks/`.

### 2026-08-10 — production parser performance correction

- The disposable Commit 1 spike measured forced evaluation of the two parser
  kernels, but did not include the complete scanner declarations, generated R4
  lookup, or all 134 aliases in the production common-path fixture. It was
  adequate for choosing fused state over an AST, but not for asserting that the
  complete replacement would remain within 10% of the segment walker's 25,872
  baseline.
- The first complete bounded parser measured 204,849 common-fixture
  instantiations on TypeScript 5.9.3. A model-known fast path, short safe-argument
  path, and compact generated metadata reduced that by 49.3% to 103,943. The
  corresponding TypeScript 5.8.3 result is 106,774. Retaining the old segment
  parser would lower this number but violate the one-parser design and preserve
  the quote/delimiter drift this work removes.
- The hard safety ceilings continue to pass with wide margins. The production
  parser plus registered capabilities used 29,572/30,169 instantiations; after
  adding the required 64/65-token, 256/257-source-step, and 255-character corpus
  cases, the full-language fixture uses 101,328/102,334. The worst independently
  compiled registered case uses 15,306/15,478, versus ceilings of 5,000,000 and
  100,000. The production common baselines are reset to 103,943 and 106,774 with
  the existing 5% regression ratchet; the completed Phase 2 fixture is
  107,708/110,580 (+3.6%/+3.6%). This is the explained parser-cost correction;
  later capability changes must still update and justify any further increase
  in their own commit.
- Parser parity raises the corpus precision baseline from 302 to 442 precise
  cases, leaves 1,905 opaque, retains every previously precise case, and reports
  zero conflicts.

### 2026-08-10 — Commit 3 literal and operator measurements

- Generated assertions now cover all 10 literal kinds, both unary operators,
  every binary/type operator, and all 13 adjacent precedence boundaries. Each
  registry entry checks its exact positive type, opaque companion, analyzer
  state, runtime fixture, and downstream composition.
- Corpus precision rises from 442 to 1,766 cases, leaving 581 opaque and zero
  conflicts. All 442 cases precise at the Commit 2 boundary remain precise; the
  operator family rises from 49 to 1,301 precise cases and the literal family
  from 288 to 1,475.
- The common fixture remains effectively flat at 107,758/110,603
  instantiations (+0.05%/+0.02% from the completed Commit 2 fixture). Expanding
  the registry-derived full-language fixture raises it from 101,328/102,334 to
  195,061/197,268, still under 4% of the 5,000,000 ceiling. The worst registered
  case uses 12,892/13,085 instantiations, below the 100,000 per-case ceiling.

### 2026-08-10 — Commit 4 calls, scope, and compiler-cache correction

- Generated capabilities now cover all 114 built-ins plus `$this`, `$index`,
  `$total`, nested lambda restoration, local bindings, built-in roots and
  constants, operator/argument scope forks, and generated Reference targets.
  Corpus precision rises from 1,766 to 2,078 cases, leaving 269 opaque and zero
  conflicts. Every case precise after Commit 3 remains precise.
- Rebuilding the five-field result tuple merely to retain a scope environment
  made TypeScript 5.8 re-evaluate nested calls. The route projection in the
  common fixture reached 1,656,674 instantiations. Keeping the tuple intact and
  attaching the environment as an intersection reduced it to 28,183. Sources
  without variables carry no environment marker, so ordinary inference keeps
  the compiler's structural cache.
- A second `defineVariable` switches only binding lookup to opaque while parsing
  and generated result rules continue. This keeps the official 60-token,
  255-source-step nested-binding case at 62,276/63,682 instantiations and still
  infers its final `isDistinct()` result. Short independent argument branches
  retain their previously precise fixed results.
- The model-known shortcut accepts four general steps and up to two trailing
  zero-argument calls. Generator assertions cap resource/element names at 33
  characters and function names at 18, proving that the shortcut remains below
  the independent 64-token and 256-source-step limits.
- The completed common fixture uses 108,885/111,837 instantiations, +1.0%/+1.1%
  from the completed Commit 3 fixture and within the existing ratchet. The
  expanded registry-derived full fixture uses 545,084/552,570, and the worst
  independent capability uses 62,276/63,682, below the 5,000,000 and 100,000
  ceilings. These values become the next phase's checked baselines.

### 2026-08-10 — Commit 5 typed host context and expanded budgets

- `FhirpathTypeDeclaration` and `FhirpathTypeContext` now carry normalized env,
  var, function, cardinality, and Reference-target declarations. Engine defaults,
  per-call options, compiled and bound expressions, projections, literal vars,
  custom-function signatures and bodies, overloads, and function-local
  `envTypes` all feed the same type-level context. A declaration beside its
  literal runtime value also checks the value type and singleton cardinality.
  An expression var may consume env values and explicitly declared vars; another
  expression var is not assumed available because TypeScript object types do not
  preserve the runtime record's declaration order. This makes forward references
  opaque instead of assigning them a type they cannot evaluate with.
- The analyzer now infers literal expression-defined function bodies under the
  call focus and temporary local declarations. This closes the soundness gap
  that would otherwise let the type layer claim more than the analyzer. Native
  functions without result declarations and ambiguous expression overloads
  remain unknown.
- The old 134-expression common fixture measures 111,897/115,080
  instantiations, +2.8%/+2.9% from Commit 4 and within the existing 5% ratchet.
  Seven new host-context cases deliberately expand that fixture to 141 cases and
  126,978/132,613 instantiations. Six generated host-context registry entries
  expand the full fixture to 580,798/607,991. The checked baselines move to
  those expanded totals; the 5,000,000 full-language and 100,000 per-case
  ceilings do not change.
- Corpus precision remains 2,078 precise, 269 opaque, and zero conflicts because
  the reference corpus supplies no host declarations. Runtime absence and error
  behavior is unchanged: ordinary navigation misses stay empty, while invalid
  function calls keep their specification errors.

### 2026-08-10 — Commit 6 final ratchet, documentation, and runtime benchmark

- The final generated precision report remains at 2,078 precise, 269 opaque,
  and zero conflicts. The final TypeScript 5.9.3 budgets are 126,978 common,
  580,798 full-language, and 64,745 worst-case instantiations; TypeScript 5.8.3
  uses 132,613, 607,991, and 66,385. No final-phase budget increase was needed.
- Public documentation now covers `FhirpathTypeDeclaration`, engine and per-call
  `envTypes`/`varTypes`, standalone contexts, merge rules, literal preservation,
  custom function body inference, and the manual opaque escape hatches. Recipes
  remove redundant annotations for row variables, operators, quantities,
  expression functions, and declared vars. Runtime error documentation keeps
  ordinary missing navigation lenient while retaining specification errors for
  unknown or invalid functions, undefined variables, singleton violations, and
  FHIR choice JSON keys.
- Regenerated the demo's ignored Monaco declarations. The editor-sample test,
  demo typecheck, and production build pass with the inferred row-index sample.
- Repeated the cross-engine harness five times on the same machine and toolchain
  as the baseline. Every run retained the same 809-case common accepted set.
  Values below are the median across runs of each run's aggregate mean, median,
  and p95:

| Engine | Metric | Median aggregate mean | Median | p95 |
| --- | --- | ---: | ---: | ---: |
| fhirpath-ts (R4 model) | Evaluation | 6.52 µs | 1.90 µs | 8.38 µs |
| fhirpath-ts (R4 model) | Parse | 1.16 µs | 1.01 µs | 2.18 µs |
| fhirpath-ts (no model) | Evaluation | 3.34 µs | 1.73 µs | 5.74 µs |
| fhirpath-ts (no model) | Parse | 1.15 µs | 997 ns | 2.15 µs |
| fhirpath-rs (octofhir 0.4.50) | Evaluation | 3.92 µs | 752 ns | 14.12 µs |
| fhirpath-rs (octofhir 0.4.50) | Parse | 6.20 µs | 5.30 µs | 12.35 µs |

The largest fhirpath-ts change in any reported median-of-runs statistic is the
model-free parse p95 at 2.3% faster, well below the 15% investigation threshold;
no reported statistic regressed. The model-aware evaluation mean is 0.9% faster
and its median is 1.0% faster.
Raw final JSON is retained outside the worktree under
`/tmp/fhirpath-type-inference-benchmarks/final-pr-head/`.
