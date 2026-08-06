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
env names from the engine and `callerEnv`).

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
