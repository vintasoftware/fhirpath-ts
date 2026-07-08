# Full Type-Level FHIRPath Expression Inference — Plan

> Status: **plan only, not scheduled**. On implementation start: keep this document
> updated via its Amendments section (repo convention).

## Context

`src/typed/infer.ts` infers `FhirpathResult<Expr>` for a deliberately small subset
of FHIRPath: dotted paths, indexers, `first()/last()/single()`, type-preserving
`where()`, `select()` over sub-paths, `ofType()/as()`, a few boolean/count
functions, and choice-element stems. Everything else degrades to `unknown[]` —
never a type error. That contract makes `evaluate()`, `first()`, and `project()`
columns precisely typed for the common cases, but real-world expressions fall out
of the subset immediately:

```ts
r4.project(patients, {
  id: 'Patient.id', // string | undefined ✓
  name: "(Patient.name.family + ' ' + Patient.name.given.join(' ')).trim()", // unknown ✗
})
```

Three independent gaps: parenthesized roots, binary operators/literals, and the
long tail of functions (`join`, `trim`, `substring`, …). The column `type`
annotation (PR #14) is the manual escape hatch; this plan is the automatic one.

Prior art proves the ceiling is high enough: **arktype** parses its whole
definition DSL in template-literal types with production editor performance,
**ts-sql** parses `SELECT` statements and infers row types, and **gql.tada** (the
original inspiration for this layer) does it for GraphQL documents. None of them
had to sit on top of a ~21k-line generated type environment (`R4Elements`/
`R4Bases`/`R4Resources`/`R4TypeOf`), which is what makes budget engineering the
core risk here — not expressiveness.

The repo already contains the semantic ground truth twice: the runtime engine,
and the static analyzer (`src/analyzer/analyze.ts` + `signatures.ts`), which
types the full grammar (`StaticState = { types, single }`). The type-level layer
is a third implementation of the same rules, so the plan's central discipline is
**generate, don't hand-write, everything that can diverge** and **dual-test
against the other two layers**.

## Goals

1. Infer precise result types (element type + cardinality) for the bulk of the
   grammar: parenthesized expressions; literals (string, number, boolean, date/
   time/quantity); binary operators (`|`, `+`/`-`/`*`/`/`/`div`/`mod`, `&`,
   comparisons, equality/equivalence, `and`/`or`/`xor`/`implies`, `is`/`as`);
   the full function table (string family, math, `iif`, aggregates, subsetting,
   conversion functions); lambda scoping (`$this` in `where`/`select`/`all`/
   `exists`/`repeat`/`aggregate`); choice elements — mirroring what the analyzer
   already models.
2. Preserve the existing contract exactly: **never a type error, degrade to
   `unknown[]`** — on unparseable input, on constructs we choose not to model
   (`resolve()`, `children()`, `%vars`), and on *budget bail* (see below).
3. Soundness bar: an inferred type must agree with the analyzer's `StaticState`
   for the same expression, or be `unknown[]`. No plausible-but-wrong types.
4. Hold compile-time and editor-latency budgets (gates defined in Phase 0).

## Non-Goals

- Type-level *diagnostics* (flagging bad expressions with error types). That is
  the analyzer/CLI/ESLint's job; this layer only refines result types.
- Typing `%env` user variables, `resolve()` targets, or reflection (`type()`).
  These stay opaque, matching the analyzer's "unknown region" behavior.
- Non-literal expressions (`string`-typed) — stay `unknown[]`.
- R5/other models. The design must keep the model maps swappable (they already
  are — `R4*` interfaces), but only R4 ships.

## Architecture

Three stages, each a tail-recursive type with an explicit accumulator, each able
to bail to `'opaque'`:

```
Expr (string literal)
  → Tokenize<Expr>        token tuple, or 'opaque'        (Phase 1)
  → ParseType<Tokens>     shift-reduce over an explicit    (Phases 2–5)
                          stack, precedence-driven,
                          producing State directly
  → ResultOf<State>       R4TypeOf lookup (exists today)
```

**Tokenizer.** `Tokenize<S, Acc extends Token[]>` consuming one lexeme per
recursion step: identifiers (and `` `delimited` ``), string literals with escape
handling, numbers, `@date/@time` literals, quantity units, multi-char operators
(`<=`, `>=`, `!=`, `!~`), punctuation. Token count is the natural budget unit:
**expressions longer than a fixed cap (initially 64 tokens) bail to `'opaque'`**.
The cap converts the open-ended "will long invariants blow the instantiation
limit?" risk into a tested constant, and keeps worst-case cost linear and known.

**Parser: fused parse+type, no AST.** Unlike arktype (which builds an AST type,
then infers from it), we produce `State = { n: typeName, many: boolean }`
directly during parsing — the same fusion the current `Step`/`ParseSegments`
does. Rationale: an AST object type roughly doubles instantiations and we never
need the tree, only the resulting type. Precedence via shift-reduce with an
explicit operator/operand stack in the accumulator (mirroring the runtime
Pratt parser's precedence table in `src/parser/`), which keeps the whole parse a
single tail-recursive loop instead of a mutually-recursive descent — that is
what keeps us inside TS's ~1000-iteration tail-call allowance rather than its
~500-deep instantiation stack.

**Typing rules.**
- Operators: a hand-written (small, spec-stable) table keyed by operator ×
  operand value-kinds — `string + string → string`, `& → string`,
  comparisons/equality/boolean ops → `boolean`, `|` → union of element types
  with `many: true`, arithmetic by numeric/temporal/quantity kind, `is` →
  `boolean`, `as(T)`/`ofType(T)` → `T`. Mixed/unknown operand kinds → opaque.
- Functions: **generated** from `FUNCTION_SIGNATURES` in
  `src/analyzer/signatures.ts` by `scripts/generate-r4-model.ts` (which already
  emits the type maps). Each entry compiles to a type-level record
  `{ result: 'boolean' | 'integer' | 'string' | 'decimal' | 'same' | 'item' | 'collection' | 'opaque' }`
  — exactly the analyzer's `BOOLEAN/INTEGER/STRING/DECIMAL/SAME/ITEM/COLLECTION/UNKNOWN`
  result combinators, which are all expressible as pure type functions over
  `State`. One source of truth; the analyzer and the type layer cannot drift.
- Lambdas: `where(expr)` type-checks its body against the item type but keeps
  the input State (as today); `select(expr)` types the body with the item State
  as root (generalizing today's sub-path support to full expressions);
  `aggregate`/`repeat` → opaque initially. `$this` resolves to the enclosing
  item State; `%resource`/`%rootResource`/`%context` → opaque.
- `iif(c, a, b)` → union of the branch States (the analyzer returns UNKNOWN
  here; this is the one place we may be *more* precise — gated on dual tests
  proving agreement with runtime results, else follow the analyzer).

**Entry points unchanged.** `FhirpathResult` / `FhirpathInput` keep their names
and call sites (`evaluate`, `first`, `project`, `BoundExpression`). The subset
parser is deleted, not kept as a second path — the new parser must subsume it
(Phase 2 exit criterion), and `infer.test.ts`'s existing dual assertions pin
that.

## Budget engineering (the actual hard part)

- **Tail-recursion only.** Every loop (`Tokenize`, the shift-reduce step) must
  be a directly self-recursive conditional type so TS 4.5+ tail-call
  elimination applies (~1000 iterations vs ~500 instantiation depth). No
  mutually recursive descent.
- **Non-distributive conditionals everywhere**: `[T] extends [U]` guards, since
  accidental union distribution over the R4 maps is the classic blowup.
- **Budget bail is a feature**: token cap + a per-construct "not modeled →
  opaque" rule means worst case degrades to today's behavior, never to a
  compile error or a tsc hang.
- **Measurement harness before any parser code** (Phase 0):
  `tsc --extendedDiagnostics` (instantiation count, check time, memory) and
  `@typescript/analyze-trace` over two fixtures: (a) a file with ~200
  representative expressions (official-suite samples + the longest FHIR core
  invariants, e.g. `bdl-*`, `obs-*`), (b) this repo's own `pnpm typecheck`.
  Numbers recorded in the fixture, asserted in CI with headroom (fail if
  instantiations or check time exceed the recorded baseline by >25%).
- **TS version matrix** in CI for the fixture job (current stable + previous
  minor): tail-recursion limits and instantiation accounting shift between
  releases; catch it before users do.
- Budget targets (validated in Phase 0, revised by amendment if unrealistic):
  repo `pnpm typecheck` wall time +10% max; fixture file under 5M
  instantiations; no single expression over ~100k instantiations.

## Testing

- **Generated dual tests, arktype-style, at conformance scale.** A generator
  script walks the official-suite cases (2,289 R4 expressions in `test-data/`)
  and, for each, runs the *analyzer* to compute the expected static type, then
  emits a type-level assertion file:
  `expectTypeOf<FhirpathResult<'…'>>().toEqualTypeOf<Expected>()` where
  `Expected` is derived from the analyzer's `StaticState` (or `unknown[]` when
  the analyzer says unknown / the expression exceeds the token cap). This makes
  "type layer agrees with analyzer" a checked-in, regenerable artifact rather
  than a hand-maintained sample. Hand-written `infer.test.ts` cases stay as the
  readable spec of intent (including the motivating `project()` example
  inferring `string`).
- **Runtime agreement spot checks** extend the existing dual-assertion pattern
  (type + evaluated value) for each newly supported construct family.
- **Soundness sweep**: the generator flags any case where the type layer is
  *more specific* than the analyzer — each needs an explicit justification
  comment or gets forced to opaque (see `iif` note above).

## Phases

Each phase ends green (typecheck, tests, budget gates) and independently
shippable, since unfinished constructs just stay opaque.

- **Phase 0 — Harness.** Budget fixtures + CI gates + TS matrix; dual-test
  generator producing today's expectations (mostly `unknown[]`). No parser
  changes. *Exit: baselines recorded and enforced.*
- **Phase 1 — Tokenizer.** Full lexeme coverage, token cap, `'opaque'` bail.
  *Exit: token-level unit tests; budget flat (tokenizer alone is cheap).*
- **Phase 2 — Parser skeleton at parity.** Shift-reduce loop handling paths,
  indexers, calls, and arbitrary parenthesization; the current subset's
  behavior reproduced through it; `StepAcrossParen` one-nesting-level hack and
  the old segment walker deleted. *Exit: existing `infer.test.ts` passes
  unchanged; budget gates hold.*
- **Phase 3 — Operators & literals.** The operator table; literal States;
  union `|`. The motivating `project()` expression infers `string` here.
- **Phase 4 — Function table.** Generator emits the type-level signature record
  from `FUNCTION_SIGNATURES`; full `select()`/lambda scoping; `iif` decision.
- **Phase 5 — Conformance & ship.** Dual-test generator switched to full
  expectations over the official suite; soundness sweep clean; README §"Static
  checking" rewritten (the "tractable subset" framing changes); token cap tuned
  against the invariant corpus.

Rough effort: Phases 0–2 are each small-PR-sized; 3 and 4 are the bulk
(operator/kind interactions and lambda scoping); 5 is mostly generated. This is
an arktype-scale investment in miniature — plan for it to span multiple PRs
with budget numbers reviewed at each one.

## Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Instantiation blowup on long expressions | Token cap → opaque; per-expression budget assertion in fixtures |
| tsserver latency in consumer editors | Fixture check-time gates; worst case is bounded by the cap; if still bad, raise/lower cap by amendment |
| Divergence from runtime/analyzer semantics | Generated function table from `signatures.ts`; generated dual tests from the official suite; soundness sweep |
| TS version behavior shifts | CI matrix on the fixture job |
| Wrong types worse than `unknown` | Soundness bar: agree with analyzer or degrade; `@ts-expect-error`-style generator flag for any extra precision |
| Complexity outliving its value | Phases 0–2 are pure infrastructure + parity; abandoning after Phase 3 still leaves operators/literals working and everything else opaque |

## Exit criteria

- The motivating expression — and every `project()` column in README/tests —
  infers its precise type with no `type` annotation.
- ≥90% of official-suite expressions under the token cap get a non-`unknown[]`
  inferred type agreeing with the analyzer; the rest are opaque, none wrong.
- Budget gates green on the CI TS matrix; repo typecheck within +10% of the
  Phase 0 baseline.
- `type` column annotations (PR #14) become optional-but-still-supported
  overrides.

## Amendments

*(none yet)*
