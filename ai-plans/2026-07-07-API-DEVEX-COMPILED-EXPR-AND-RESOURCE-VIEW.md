# High-level API DevEx: compiled-expression consistency + resource-scoped view

## Context

A DevEx comparison of `FhirPathEngine` against fhirpath.js, fhirpath-py, fhirpath-rs,
and Medplum found our high-level API already leads on model-binding (one bound `r4`
instance vs positional/global-singleton models), compile-time result/input types (unique
in the field), the jobs helpers (`test`/`filter`/`project`/`checkConstraints` — no JS
competitor has this breadth), and a typed error hierarchy (everyone else throws plain
`Error`). It has three concrete gaps; this plan closes two of them. Custom-function
extensibility (the third) is planned separately.

Ordered by dependency: #2 clarifies the expression-type model that #3 builds on.

---

## #2 — Compiled expressions first-class across helpers (fixes a latent bug)

**Problem.** `engine.compile()` returns a `BoundExpression`, but `evaluate`/`first`/
`evaluateTyped`/`test`/`filter` accept only `AnyExpression` (`string |
CompiledExpression`). Passing a `BoundExpression` is a type error; forcing one through
`cachedCompile` (`src/api/compile.ts:76`) returns it as-is and then calls its own
`.evaluate*`, silently re-routing through *its* engine's defaults (possibly a different
model) — a latent correctness bug. The net effect: an expression compiled via the engine
cannot be reused in the helper methods, defeating compile-once for exactly the hot paths
those helpers serve.

**Fix** (all in `src/api/engine.ts`):
- Add a private normalizer `toCompiledArg(expr)` that unwraps a `BoundExpression` to its
  inner `.expression` (a `CompiledExpression`), otherwise returns the arg unchanged. A
  `BoundExpression` is then treated purely as a parsed AST — the *receiving* engine's
  merged options apply (consistent with how `CompiledExpression` already behaves).
- Widen the accepting methods' expression parameter to
  `Expr | CompiledExpression<Expr> | BoundExpression<Expr>` (`evaluate`, `first`) and
  `AnyExpression | BoundExpression` (`evaluateTyped`, `test`, `filter`), routing through
  `toCompiledArg` before `cachedCompile`.
- Add `filter(input, options?)` to `BoundExpression` for compile-once symmetry with its
  existing `test`, so `const adult = r4.compile('age >= 18'); adult.filter(patients)`
  works. (`project`/`checkConstraints` stay data-shaped — their expressions live inside
  `ProjectionColumns` paths / `FhirConstraint.expression` strings, already parse-cached
  by `cachedCompile`; no change.)

**Tests** (`src/api/engine.test.ts`): a `BoundExpression` from `engineA.compile(...)`
passed to `engineB.evaluate(...)`/`.filter(...)` uses engineB's model; `adult.filter(...)`
returns the same as `r4.filter(patients, 'age >= 18')`.

---

## #3 — Resource-scoped view: `r4.on(resource)`

**Problem.** `evaluate`/`first` are expression-first; `test`/`filter`/`project`/
`checkConstraints` are subject-first (a deliberate but real autocomplete-time
inconsistency — the split is documented in the `FhirPathEngine` class doc). No competitor
has these helpers, so there's no external convention to match.

**Fix.** Add `on(input: EngineInput): ResourceView` to `FhirPathEngine` and a new
`ResourceView` class in `src/api/engine.ts`. The input is bound once; every method then
takes expression/columns/constraints first, so within a view there is *no* subject
argument and the ordering split disappears:

```ts
const v = r4.on(patient)
v.evaluate('name.given')          // string[]  (still infers result type from the literal)
v.first('name.family')            // string | undefined
v.test('name.exists()')           // boolean
v.project({ id: 'id' })           // one row (or one row per resource for array/Bundle input)
v.checkConstraints(constraints)   // ConstraintCheckResult
r4.on(patients).filter('age >= 18')
```

Each method delegates to the existing engine method with the bound input, so Bundle/array
transparency and options merging are unchanged. `evaluate`/`first` keep
`<const Expr extends string>` generics for result-type inference. Naming: `on` is not a
FHIRPath/FHIR term of art, reads as "evaluate on this resource," and does not collide with
existing method names.

**Tests** (`src/api/engine.test.ts`): each view method matches its engine-method
counterpart; array/Bundle input produces one row per resource in `v.project`.

---

## Files touched

- `src/api/engine.ts` — #2 normalizer + widened signatures + `BoundExpression.filter`;
  #3 `on()` + `ResourceView`.
- `src/index.ts` — export `ResourceView`.
- `README.md` — document `on()` in the jobs-helpers section.
- Tests: `src/api/engine.test.ts`.

## Verification

- `pnpm test` — full suite incl. official R4/R5 + fhirpath.js corpora must stay green
  (proves no regression in core eval).
- `pnpm typecheck` — confirms the widened signatures and inference still hold
  (e.g. `r4.on(patient).evaluate('name.given')` is `string[]`).
- `pnpm lint` (`biome check`).
- New tests above cover each feature (the cross-engine `BoundExpression` model check and
  the `on(...)`-vs-direct-method equivalence are the real behavioral checks).
