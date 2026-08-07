# Working in this repo

Conventions live in the code and its comments; the README is the user-facing
documentation. This file records **decisions that are cheap to break and
expensive to rediscover** — the ones where the obvious refactor is the wrong one.
Add to it when a decision survives a real debate, not for every choice.

## Two walkers, one AST each — and the compiler is the caller's

Expression-site extraction has exactly two implementations, one per AST kind:

- **`src/eslint/index.ts`** walks ESLint's ESTree, because a lint rule is handed
  an AST and must report on its nodes.
- **`src/sites/index.ts`** (`fhirpath-ts/sites`) walks the real TypeScript AST
  for everything else: the `fhirpath-check` CLI, the demo playground's editor
  markers, a bundler plugin. `createSiteFinder(ts)` takes the TypeScript
  namespace **as an argument** — the entry point itself imports only types — so
  the package keeps its zero-runtime-dependency promise while each caller brings
  the compiler it already has: the CLI passes the `typescript` package (optional
  peer), the demo passes the copy Monaco ships in its worker (`globalThis.ts`,
  set by ts.worker at module scope), and nobody bundles a second compiler.

There used to be a third: a hand-written `typescript`-free lexical scanner, plus
a reference walker kept only as its parity oracle (a repo-wide
compare-both-walkers test). Both were deleted when the demo — the one consumer
that genuinely could not reach a compiler, because its lint ran synchronously on
the main thread while Monaco's TS sits behind an async worker — moved extraction
*into* that worker (see below). Do not reintroduce a scanner without a consumer
that measurably cannot do that.

What still follows:

- Do not make the CLI depend on ESLint to reuse the rule. It would cost the
  CLI's niche (Biome and other non-ESLint repos) and silently drop
  warning-severity diagnostics such as `regex-backtracking`, because ESLint
  severity is per-rule, not per-report.
- The CLI requires `typescript` (optional peer) for both halves now: sites for
  the source half, `src/cli/ts-loader.mjs` for the DTO half.
- `fhirpath-ts/analyzer` stays free of the compiler: `analyzeExpression`,
  `analyzeDto` and `analyzeSite` have genuine runtime uses (a rules editor
  validating what a user typed), and those hosts must not pay for TypeScript.
  Source-reading is the one job that needs it, and it lives in
  `fhirpath-ts/sites` for exactly that reason.
- When a walker learns a new shape, the *decision* belongs in
  `src/analyzer/expression-policy.ts` (call table, argument positions, receiver
  rules, `isCheckedTag`, `siteContext`, `rootOf`/`dtoRootsOf`, shape extraction
  through the `ExpressionAst` adapter) and the *analysis* in `analyzeSite`. A
  walker should only supply AST access — which node kinds hold a name, a class, a
  literal. In particular, a site kind that gates itself is the bug: the
  `` fhirpath`…` `` tag hand-rolled its own `foreign.has(TAG_NAME)` test in each
  walker, neither consulted the receiver, and a `hb.fhirpath` tag under a
  handlebars namespace import was reported as invalid FHIRPath. Gates go through
  `isCheckedCall`/`isCheckedTag`.
- The line above is load-bearing, and `src/analyzer/expression-policy.test.ts` is
  what holds it: one corpus through both walkers, compared on positions *and* on
  the diagnostics `analyzeSite` produces from each. The context comparison exists
  because the two once drifted where only context differed — the rule resolved a
  tag name and an `extends defineDto(…)` callee with its own Identifier-only
  tests, so a namespace-imported `api.fhirpath` tag and root went unchecked there
  while `fhirpath-ts/sites` checked both. Positions alone did not catch it. Add
  to that corpus whenever either walker learns a shape.

## The demo extracts sites inside Monaco's TS worker

`demo/src/playground/ts.custom.worker.ts` is Monaco's own TypeScript worker plus
a side channel: the side-effect import wires Monaco's protocol unchanged and
exposes the bundled compiler as `globalThis.ts` (ts.worker does that at module
scope), and `createSiteFinder` runs on it. The two protocols share one worker
safely because Monaco guards both directions with
`if (!message || !message.vsWorker) return` (vs/base/common/worker/webWorker.js)
while the side channel answers only messages carrying `fhirpathSites`. The
playground's `lint()` is async as a result: request id + model version guard
drop stale answers. `analyzeSite` still runs on the main thread — the analyzer
needs no compiler.

If a Monaco upgrade breaks this, the things to re-check are those three facts:
`globalThis.ts` still set, the `vsWorker` guard still present, and
`MonacoEnvironment.getWorker` still letting us construct (and keep a handle to)
the worker ourselves.

## `fhirpath-check` has two halves, and DTOs live in `*.dto.ts`

The CLI reads source (half one, the scanner) *and* imports the project (half two,
`src/cli/dto-check.ts`): DTO modules are loaded through `src/cli/ts-loader.mjs`,
the engines they construct are discovered, and `analyzeDto` runs with the real
context. Keep the halves distinct — the first must never be wrong, the second is
allowed to be exhaustive because it has the engine.

Discovery is convention, not configuration, and each rule earns its keep:

- `*.dto.ts` is the default glob (`--dtos` overrides). One convention beats a
  config file the user has to write and keep in step.
- DTO classes must be **exported** to be found: a module's exports are all a
  loader can see. A subclass is not discoverable at definition time — `@column`
  learns its class only when an instance is first constructed — so there is no
  way to enumerate "every DTO in the process".
- Engines need **no** export: `recordEngines()` in `src/api/engine.ts` opens a
  recording session and returns the way to close it, so a checker records around
  its own imports and nothing is retained before or after. Engines are usually
  module-private, which is why scanning exports is not enough. Keep the session
  closable — an always-on switch would hold every engine, and its env, for the
  life of the process.
- Per-call env is the DTO's declaration (`DtoOptions.callerEnv`), not the
  checker's flag. If a checker needs to be told something about a DTO, the DTO is
  the place to say it.
- No engine in reach means column-to-column calls cannot resolve, so those
  findings are reported as warnings and the run still passes. Do not "fix" that
  by failing the run.
- A DTO no engine registers is checked against every engine's context *merged*,
  not against each engine in turn with the quietest answer kept. "Some engine in
  this project declares this" is the most that can be said without being told
  which, and merging says exactly that, once and deterministically.

Do not add a `fhirpath.config.ts`. It was considered and rejected: everything it
would hold is discoverable (engines by recording, DTOs by convention plus export,
env names from the engine, the DTO's own `static env`, and `callerEnv`).

## `analyzeSite` decides what a source walker may claim

`analyzeSite` (`src/analyzer/analyze.ts`) is the single place that turns a found
site into diagnostics, so the rule, the CLI, and the editor agree. It exists
because a source walker sees less than the runtime does, and reporting valid code
is worse than missing a check:

- A DTO column's `%vars` may come from a base class or the projecting call →
  `unknown-variable` is dropped on DTO sites.
- A DTO in another module is invisible → `unknown-function` survives only when
  the name plausibly misspells a column the same file declares.
- No statically-known `fhirType` → syntax findings only. A relative path is not
  just uncheckable there: a leading `code`/`text`/`status` segment is itself a
  model type name, so the analyzer would read it as a type-name root and report
  nonsense. What counts as statically known is `dtoRootsOf`: a class's own
  `extends defineDto('X')`, or a base class *the same file declares* — sharing
  columns through a base class is the documented pattern, and a base lends its
  root along with them. A factory call (`extends keyedRow('Condition')`) or an
  imported base is where it stops; so is a class name the file declares twice,
  since a wrong root reports valid code.

`analyzeDto` is the strict counterpart, for a test that has the classes loaded
and the engine's real function set. Keep the two roles distinct: lint must never
be wrong, `analyzeDto` must never be lenient.

## Registering a DTO is a namespace, checked at the edges

`EngineOptions.resourceDtos` turns each `@column` and `@criteria` into an
expression-defined function. What each function carries is the type it was
written for, in `CustomFunctionSignature.input.types`, taken from the DTO's
`fhirType`. Both the engine and the analyzer reject a call whose focus can never
hold that type. So `code.displayText()` on a Condition runs, while
`status.displayText()` throws `FhirPathTypeError` instead of navigating to
nothing.

That declared type is also what scopes the name. A column name belongs to the
type its DTO was written for, not to the engine, so a CodeableConcept DTO and a
Coding DTO may both declare `displayText` and a call resolves to the one its
focus fits — `resolveByInput` (values/type-compat.ts) tries the declarations in
registration order and takes the first the focus satisfies, at both ends.
A focus none of them accepts is one error naming all of them.

What `withDtos` refuses is a name whose declarations a call could *not* tell
apart, since that is what shadowing actually is: a `Quantity` column beside a
`SimpleQuantity` one, two DTOs on one fhirType claiming the same field name,
anything beside a host function that accepts every focus, or any pair at all on
an engine with no model to compare types with. The refusal is at construction
and names the field, so it is never a mystery at evaluation.

Names are the whole of the rule. There used to be a one-DTO-per-fhirType check
on top of it, from before columns declared their input type; it refused a second
Observation DTO even when every field name was distinct, which is the ordinary
shape of an app (a weight row, a blood-pressure row, a lab row). Do not bring it
back: the per-name check already catches the only case it caught, with a message
that names the field rather than the class.

Registering a DTO adds function names and nothing else. A DTO's `static env`
travels on its columns as an overlay (`HostExpressionFunction.env`), laid over
the caller's environment for the length of one body and gone again after it, so
an env name has no engine-wide namespace to collide in and no pairwise check to
pass. Two DTOs may mean different things by `%system`.

Do not restore the engine-wide merge. A column body reading its own DTO's env is
not a departure from "the body evaluates as if spliced at the call site" — every
other name still resolves to the caller's, including `%context`, the built-ins,
per-call env and `%rowIndex`. What it removes is a DTO publishing its private
data to every expression the engine evaluates, which nothing asked for. An
engine-wide variable is `new FhirPathEngine({ env })`, where the host says so.

The two routes to that env must agree on precedence, and both give the DTO the
name: the overlay lays the DTO's values over the caller's, and `dtoCallOptions`
lays them over the projecting call's. Do not make either one call-wins. A DTO
reached by both routes in one `project()` — a column path and a column called
through a `var` — would otherwise answer the same declaration two ways in one
operation. A projecting call varies data through the names the DTO declares as
`callerEnv`, which is what that field is for.

Call-wins is not available as the other unification, so do not reach for it as
the "simpler" fix. An evaluation context holds one merged env map with no record
of where a name came from (`EvaluationContext.env`), so an overlay cannot tell a
per-call name from an engine-wide one. Making it defer to the caller would let
any engine-level name shadow a DTO's private table, which is the collision this
scoping removes.

`vars` cannot travel the same way and should not be made to. A var is an
expression evaluated against a row; a call has a focus, not a row. That
asymmetry is real — env travels with a called column, vars do not — and is
documented rather than papered over. `vars` stay under the projecting call,
which is not the same split: a var is reached by one route only, so there are no
two answers to reconcile.

Dispatch is by the focus and nothing else, which leaves the cases
`unsatisfiedInput` is deliberately silent about — an empty focus, a focus type
no model describes — fitting every declaration. The first registered wins those,
and it barely matters: they are the cases where every body navigates to nothing
anyway. Do not add a second tie-breaker to sharpen this. The registration check
is what keeps the guess from reaching a focus that could have gone either way.

**What the check deliberately does not do.** It reports only what it can prove,
because reporting valid code is worse than missing a mistake. It says nothing
about any of these:

- an empty focus, which is the spec's own empty propagation
- no model bound
- a focus type the model has never heard of, which is the `Object` placeholder
  carried by plain env data, a pre-resolved `%var`, and a datatype root
- a declared name the model rejects
- a mixed focus where any one item could fit

It is also permissive about what "can be" means. Either direction of the model
hierarchy counts, `System.Quantity` and `FHIR.Quantity` are one type, and
sibling primitives such as `code` and `uri` are not told apart.

That whole rule is **one function**: `unsatisfiedInput` in
`values/type-compat.ts`, which returns the proof rather than a verdict. The two
halves differ only in how they report it, since `resolveHostCall` throws and
`checkCallInput` reports `input-type`. That is what stops the list above from
drifting between them. Keep it that way. The analyzer and the engine cannot
import each other, which justifies two callers, but never two copies of the
rule. One more thing to watch: `typesOverlap` must run its model test even when
the value kinds differ. `FHIR.SimpleQuantity` has kind `Complex` while
`FHIR.Quantity` has kind `Quantity`, so testing kinds first would reject a
`Quantity` column called on `Dosage.doseAndRate.dose`.

No **built-in** may set `input.types`. Spec functions accept many types, so a
built-in that named types would start reporting valid expressions from the
official test suite. `signatures.test.ts` checks that none does.

The lint and editor half reads each class's root from the source, so a file can
declare one field name twice against different roots. Both of them can register,
so `declaredColumnOverloads` keeps both, and the analyzer resolves the set the
same way the engine does.

Keeping the last declaration seen is the tempting shortcut and it reports valid
code: with a `label` column on a Coding and another on a CodeableConcept,
`code.label()` becomes an `input-type` error even though the CodeableConcept
declaration answers that call. `expression-policy.test.ts` holds the case, and
it fails if the merge goes back to last-wins.

Where the focus cannot pick — two `label`s on the same root, or one whose class
has no statically-known root and so answers every call — the call is checked
against all of them at once (`mergedDeclaration`, analyzer/analyze.ts). That
merge only ever widens: the result is their union, so a `label` typed `string`
in one class and `integer` in another leaves `code.label().length()` unchecked
rather than reporting it; arguments go unchecked; and the input is every type
any of them named, so two `label`s on a CodeableConcept still make
`subject.reference.label()` an `input-type` error. All three cases are in the
same suite.

What is still guessed, and accepted: a file sees only its own columns, so a call
into a column declared in another module stays unresolved. `analyzeSite` reports
that as `unknown-function` only when the name nearly misspells one of this
file's own columns.

`@criteria` registers with `criteria: true` on its `CustomFunction`. That flag
is where its rule lives: `criteriaBoolean` (values/collection.ts) applied to the
body's result, on the function rather than in `planColumn`. It is what makes one
declaration mean one thing. `isFinal()` returns exactly one boolean in both
places, so `isFinal().not()` on a resource with no `status` is `true` whether it
is projected or called.

Two rules stack there, and the citation is worth keeping honest. §4.5, Singleton
Evaluation of Collections, gives the single-item cases and the error for more
than one item, but its empty case is empty. The `?? false` comes from the
calling environment: FHIR invariants require the expression to evaluate to true,
so an empty result has not satisfied the constraint. **Do not move `?? false`
down into `booleanSingleton`.** `engine/operators/logic.ts` passes its
`undefined` into the three-valued and/or/xor/implies tables, and turning it into
false there breaks `{}` against `false`. `where()`, `exists()`, `all()`, and
`iif()` keep their own `=== true` tests for the same reason. They produce the
same answers, but they state spec text about one item rather than this rule.

One caveat comes with a criteria call: its body runs against the call's focus,
not the DTO's root. Without the input-type check, `code.isFinal()` would answer
a confident `false`. Because the criteria rule always returns true or false, a
wrong focus produces a plausible answer rather than an empty one, so the two
features depend on each other.

`analyzeEngineDtos(engine)` sweeps only what the engine registered, so a row
shape you merely project is invisible to it. Do not read it as exhaustive — the
CLI's DTO half is the one that finds every DTO, by convention plus export.

## DTO decorators need a lowering step

`@column`/`@criteria` are TC39 standard decorators. oxc (Vite/Vitest) cannot
lower them, so `vitest.config.ts` carries a tsc `transpileModule` plugin. It is
pinned to **ES2022 on purpose**: at `target: esnext` tsc emits decorators
untouched ("the runtime has them"), which fails at import with
`SyntaxError: Invalid or unexpected token`. The demo's Monaco compiler options
carry the same pin.

Legacy (`experimentalDecorators`) decorators are not an option: their signature
has no `Value` type parameter, so the field's declared type cannot be checked
against the column's inferred type — the whole point of the decorator form.

A field decorator can only record through the initializer it returns, so
`dtoDefinition` collects a class's columns by instantiating it once, with
`collecting` naming the class for the duration. **Save and restore that variable,
never clear it**: a plain field initializer can reach another DTO's definition
(`new FhirPathEngine({ resourceDtos })` is enough), and clearing on the way out of
the inner call ends the outer class's collection at that field — every column
below it is dropped silently, or the class appears to declare none at all.
`src/api/dto.test.ts` covers the re-entrant case for exactly this reason.

## Gates

`pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm check:fhirpath` (the DTO
sweep), `pnpm check:type-perf` (an
instantiation budget in `scripts/type-perf-budget.json`; raise it in the same
change and say why), and `pnpm coverage` thresholds. The demo has its own
`typecheck`, and `demo/src/monaco/*.d.ts` are generated — run
`npm run generate:dts` in `demo/` after changing the public API.
