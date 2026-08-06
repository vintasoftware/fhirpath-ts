# Working in this repo

Conventions live in the code and its comments; the README is the user-facing
documentation. This file records **decisions that are cheap to break and
expensive to rediscover** — the ones where the obvious refactor is the wrong one.
Add to it when a decision survives a real debate, not for every choice.

## Two static walkers, one oracle

Three consumers need to find FHIRPath expression literals in source code, and
they are deliberately *not* three implementations of that search:

- **`src/eslint/index.ts`** walks ESLint's ESTree, because a lint rule is handed
  an AST and must report on its nodes.
- **`src/analyzer/lexical-sites.ts`** is a `typescript`-free scanner, and it is
  what everything else uses: the `fhirpath-check` CLI, the demo playground's
  editor markers, and any bundler plugin. A browser host cannot ship the
  TypeScript compiler, and the CLI's whole reason to exist is being usable in a
  repo that does not install our lint stack — so it stays dependency-light.
- **`src/analyzer/reference-sites.ts`** is the same policy over a real TypeScript
  AST, and exists **only as the test oracle**. `lexical-sites.test.ts` runs it
  and the scanner over every `.ts` file in the repo and fails on any
  disagreement, down to each site's DTO context and declared column functions.

What follows from that:

- Do not point the CLI (or any shipped code) at `reference-sites.ts`. It was the
  CLI's walker once; making that mistake again reintroduces a second production
  walker to keep in step.
- Do not make the CLI depend on ESLint to reuse the rule. It would cost the
  CLI's niche (Biome and other non-ESLint repos) and silently drop
  warning-severity diagnostics such as `regex-backtracking`, because ESLint
  severity is per-rule, not per-report.
- When a walker learns a new shape, the *decision* belongs in
  `src/analyzer/expression-policy.ts` (call table, argument positions, receiver
  rules, shape extraction through the `ExpressionAst` adapter) and the *analysis*
  in `analyzeSite`. A walker should only supply AST or token access.
- Never repair a scanner/oracle disagreement by changing the oracle to match the
  scanner. The oracle is the reference; the scanner is what may be wrong.

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
- Engines need **no** export: `recordEngines()`/`recordedEngines()` in
  `src/api/engine.ts` record constructions while a checker asks for it (off by
  default, so an application retains nothing). Engines are usually
  module-private, which is why scanning exports is not enough.
- Per-call env is the DTO's declaration (`DtoOptions.callerEnv`), not the
  checker's flag. If a checker needs to be told something about a DTO, the DTO is
  the place to say it.
- No engine in reach means column-to-column calls cannot resolve, so those
  findings are reported as warnings and the run still passes. Do not "fix" that
  by failing the run.

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
- No statically-known `fhirType` (the class extends a base class or a
  root-generic factory) → syntax findings only. A relative path is not just
  uncheckable there: a leading `code`/`text`/`status` segment is itself a model
  type name, so the analyzer would read it as a type-name root and report
  nonsense.

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

## Gates

`pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm check:fhirpath` (the DTO
sweep), `pnpm check:type-perf` (an
instantiation budget in `scripts/type-perf-budget.json`; raise it in the same
change and say why), and `pnpm coverage` thresholds. The demo has its own
`typecheck`, and `demo/src/monaco/*.d.ts` are generated — run
`npm run generate:dts` in `demo/` after changing the public API.
