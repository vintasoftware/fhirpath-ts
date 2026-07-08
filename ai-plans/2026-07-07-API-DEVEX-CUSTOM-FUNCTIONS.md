# High-level API DevEx: per-engine custom functions

## Context

A DevEx comparison of `FhirPathEngine` against fhirpath.js, fhirpath-py, fhirpath-rs,
and Medplum found that three of the four competitors let users add functions —
fhirpath.js/py via `options.userInvocationTable`, fhirpath-rs via a pluggable
`FunctionRegistry` — while we expose none. We *have* a function registry internally
(`src/functions/registry.ts`) but it is a process-global `Map` and is not part of the
public API, so consumers cannot extend the engine at all.

This is the third of three DevEx gaps from that comparison; the other two
(compiled-expression consistency and the `r4.on(resource)` view) are planned separately.

**The differentiated angle:** unlike the competitors, our custom functions declare their
arity so the static analyzer stays sound — a registered custom function is treated as a
known-but-opaque region (its result degrades to `unknown[]`), never a false type
inference and never a spurious "unknown function" error.

The correctness study (`ai-plans/2026-07-08-CORRECTNESS-GUARANTEES.md`, WS3)
strengthened this angle: HAPI's host services model a custom function as a *triple* —
declare (existence + arity, consulted at parse), check (static argument/result types,
wired into its type checker), execute — and skipping the check leg is what breaks
static analysis of any expression using the function. fhirpath.js/py/rs all skip it.
We adopt it as an optional `signature` field: a typed custom function participates in
analysis like a built-in, while an arity-only one still degrades safely to unknown.

**Sequencing:** the correctness roadmap is implemented first; this plan lands after.
None of its analyzer workstreams change the `FunctionSignature` shape this plan
reuses (`ofType`/`as` narrowing and `select` body typing adjust individual entries,
not the shape).

**User-confirmed decisions:**
1. Custom functions take/return **plain JS values** (not the internal `TypedValue`) — the
   best DevEx for the common cases (formatting, lookups, arithmetic on numbers/strings).
2. **Eager arguments only** — arguments are pre-evaluated against `$this`. Lambda/`Expr`-
   style custom functions (like `where`/`select`) are out of scope for v1.
3. Custom functions **may not override a built-in** FHIRPath function — a collision throws
   a clear `FhirPathError`. (fhirpath.js allows overriding; we reject it to keep the spec
   surface stable and the analyzer sound.)

---

## Public shape

New module `src/api/custom-functions.ts`:

```ts
export interface CustomFunction {
  /** Inclusive minimum argument count; default 0. */
  minArity?: number
  /** Inclusive maximum argument count; default = minArity. */
  maxArity?: number
  /**
   * Optional static types for the analyzer (the "check" leg of HAPI's
   * declare/check/execute triple): input constraint, per-argument specs, and the
   * result state. Without it, calls analyze as known-but-opaque (result unknown).
   * Mirrors the analyzer's `FunctionSignature` (`src/analyzer/signatures.ts:28-39`)
   * with a plain-object `result` instead of a function.
   */
  signature?: {
    input?: { kind?: ValueKind; singleton?: boolean }
    args?: ArgSpec[]
    result?: { types: string[]; single: boolean }
  }
  /**
   * input: the collection the function is invoked on (unwrapped JS values).
   * args:  each declared argument, pre-evaluated against $this (unwrapped JS values).
   * Returns plain JS values, re-wrapped into the result collection.
   */
  apply(input: unknown[], args: unknown[][]): unknown[]
}
```

`EvaluateOptions` (`src/api/compile.ts`) gains
`functions?: Record<string, CustomFunction>`. Registered once on an engine
(`new FhirPathEngine({ model, functions })`) or passed per call (merged field-by-field
by the engine's existing `merged()`).

```ts
const fp = new FhirPathEngine({
  model: r4Model,
  functions: {
    pow: { maxArity: 1, apply: (input, [exp]) => input.map(n => (n as number) ** (exp?.[0] ?? 2)) },
  },
})
fp.evaluate('a.pow(3)', { a: [2] }) // [8]
```

Adding a signature makes the analyzer type the call instead of muting it:

```ts
pow: {
  maxArity: 1,
  signature: {
    input: { kind: 'Numeric', singleton: true },
    args: ['Numeric'],
    result: { types: ['System.Decimal'], single: true },
  },
  apply: (input, [exp]) => input.map(n => (n as number) ** ((exp?.[0] as number) ?? 2)),
}
// analyzer: 'a.pow(3)' → single System.Decimal; 'name.pow(1)' → operand-type diagnostic
```

`ValueKind` and `ArgSpec` are re-exported from `src/analyzer/signatures.ts`.

---

## Design

**Adapter** (`src/api/custom-functions.ts`): `adaptCustomFunctions(record)` →
`Map<string, FhirPathFunction>` (the internal shape in `src/functions/registry.ts`).
Each adapted function:
- eagerly evaluates each argument AST via the supplied `evaluateNode` callback against
  `$this` (reusing the `evaluateArgument` pattern at `src/engine/evaluator.ts:25`), then
  `unwrap`s each to plain values;
- `unwrap`s the input collection to plain values, calls `apply`, and re-wraps the result
  via `toCollection` (`src/values/typed-value.ts`);
- carries `minArity`/`maxArity` for validation.

**Collision policy.** At adapt time, throw `FhirPathError` if a name matches a built-in
(check against `functions` from `src/functions/registry.ts`). Custom-vs-custom collisions
are impossible (object keys are unique).

**Threading (runtime).**
- `EvaluationContext` (`src/engine/context.ts`) gains
  `functions?: ReadonlyMap<string, FhirPathFunction>`; `createContext` accepts and stores
  it. The api layer (`src/api/compile.ts` `evaluateTyped`) adapts `options.functions` →
  internal map and passes it in.
- Evaluator `'call'` case (`src/engine/evaluator.ts:66-68`): resolve
  `context.functions?.get(name)` first, else `lookupFunction(name, argc)`. When a custom
  function resolves, validate arity with the same `describeArity` message shape.

**Threading (analyzer).** `AnalyzeOptions` (`src/analyzer/analyze.ts:18`) gains
`functions?: Record<string, Pick<CustomFunction, 'minArity' | 'maxArity' | 'signature'>>`.
In `walkCall` (`analyze.ts:228`), a name found among custom functions is treated as
known — arity is checked, then:
- **with a `signature`**: the declared shape is adapted into the internal
  `FunctionSignature` (its `result` becomes `() => declared state`) and the call gets
  the same checks as a built-in — input kind/singleton, per-argument `ArgSpec`s, and
  the result state flows into downstream analysis (HAPI's `checkFunction` analog);
- **without one**: it returns the `UNKNOWN` static state (muting downstream type
  checks, exactly the §11 unknown-region behavior).

Custom calls therefore never produce false inference — they are either declared-typed
or degrade to unknown.

---

## Known v1 limitations (documented in README)

- **Eager args only** — lambda/`Expr`-style custom functions are not supported.
- **Compile-time (tsc) inference degrades to `unknown[]`** for custom-function results —
  custom names aren't in the type-level inference subset (`src/typed/infer.ts`). The
  `signature` field types calls in the *analyzer*; it cannot reach tsc-level inference.
- **The `fhirpath-check` CLI / ESLint rule** scan source and don't discover an engine's
  `functions`; a custom call there is flagged unknown unless the analyzer options are
  given the functions (names + optional signatures). Type-level inference does not
  error (degrades to `unknown[]`). Note this in the Static-checking section of the
  README.
- **No typed `%variables` yet** — HAPI pairs `resolveConstant` with
  `resolveConstantType`; an `AnalyzeOptions.variables` map with declared types is the
  analog, deferred as a follow-up (correctness roadmap WS3 mentions it).

---

## Files touched

- `src/api/custom-functions.ts` (new) — `CustomFunction`, `adaptCustomFunctions`.
- `src/api/compile.ts` — `EvaluateOptions.functions`; adapt + pass to `createContext`.
- `src/api/engine.ts` — nothing beyond passing `functions` through `merged()` (already
  generic over `EvaluateOptions`).
- `src/engine/context.ts` — `functions` on context + `createContext`.
- `src/engine/evaluator.ts` — custom-function-first lookup + arity check.
- `src/analyzer/analyze.ts` — `AnalyzeOptions.functions`, `walkCall` acceptance +
  signature-based checking.
- `src/analyzer/signatures.ts` — no shape change; `ValueKind`/`ArgSpec` become part of
  the public surface (re-exported).
- `src/index.ts` — export `CustomFunction` (+ re-export `ValueKind`, `ArgSpec`).
- `README.md` — document custom functions + v1 limitations.
- Tests: `src/api/engine.test.ts`, `src/analyzer/analyze.test.ts`.

## Verification

- `pnpm test` — the `pow` example actually evaluating through `r4.evaluate(...)` is the
  real behavioral check; per-call vs engine-default `functions`; collision with a built-in
  throws; arity error message shape; full official R4/R5 + fhirpath.js corpora stay green.
- `pnpm typecheck` — `CustomFunction` shape and `EvaluateOptions.functions` compile;
  custom-call results are `unknown[]`.
- `pnpm lint` (ESLint + Prettier, including the dogfooded analyzer rule).
- New analyzer tests: a registered custom function is not flagged `unknown-function`,
  and a wrong-arity call is; with a `signature`, a wrong input/argument kind is flagged
  and the declared result type flows into downstream checks; without one, the result is
  an unknown region.
