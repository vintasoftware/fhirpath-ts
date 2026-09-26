# Working in this repository

This file records maintenance decisions that are easy to break. User-facing
behavior belongs in the documentation:

- [README.md](README.md): features, suggested use, short recipes, and important
  limits.
- [API reference](docs/api.md): engine methods, options, custom functions, DTOs,
  Bundles, and caching.
- [Static checking](docs/static-checking.md): inference, ESLint, CLI, and analyzer
  behavior.
- [Conformance](docs/conformance.md): suites, skips, fuzzing, and coverage.
- [Engine comparison](docs/engine-comparison.md): comparison and architecture.
- [Demo README](demo/README.md): playground development and deployment.

Keep this file focused on implementation constraints. Add a rule after a real
design decision, not for ordinary code conventions.

## Expression-site walkers

There are two source walkers because their callers receive different ASTs:

- `src/eslint/index.ts` walks ESLint's ESTree.
- `src/sites/index.ts` walks the TypeScript AST for the CLI, demo, and other
  source tools.

`createSiteFinder(ts)` receives the TypeScript namespace from its caller. The
`fhirpath-ts/sites` entry point imports TypeScript types only. This keeps
TypeScript out of runtime dependencies and lets Monaco use the compiler already
inside its worker.

Do not add a third walker unless a real consumer cannot supply either supported
AST.

Keep decisions shared between the walkers in
`src/analyzer/expression-policy.ts`: call names, expression argument positions,
receiver checks, tag checks, DTO roots, site context, and expression shapes. A
walker should only translate its AST into that shared policy.

Do not make the CLI call the ESLint rule. The CLI must work in projects that do
not use ESLint, and it must keep analyzer warning severities such as
`regex-backtracking`.

`src/analyzer/expression-policy.test.ts` runs one corpus through both walkers and
compares positions, context, and analyzer diagnostics. Add every new source shape
to that corpus.

The analyzer package stays independent of both compilers. Runtime tools such as
an expression editor can call `analyzeExpression`, `analyzeDto`, and
`analyzeSite` without loading TypeScript.

## Type-level inference

`src/typed/parser.ts` is the only type-level parser. It consumes generated
parser, function, and R4 model metadata. Keep the runtime parser, analyzer
signatures, and model maps as the sources of truth; do not add handwritten
copies.

Keep inference bounded by `src/typed/inference-limits.ts`. Returning `unknown[]`
is safe; returning a type narrower than `analyzeExpressionDetailed()` is not.
The required checks below cover generated drift, corpus soundness, and compiler
cost. A helper that means "nothing to read" returns a sentinel such as
`undefined`, not `never`: `never` distributes through later conditionals and
erases the whole result (`HostBodySource` did this for host functions without a
body or result type).

Normalize host declaration names through `src/typed/context-maps.ts`. Per-call
declarations override engine defaults, matching runtime option merging.
Infer literal `env` values before applying `envTypes`; explicit declarations
remain the override for widened values and Reference targets.

## Monaco worker integration

`demo/src/playground/ts.custom.worker.ts` adds expression-site extraction to
Monaco's TypeScript worker. The side-effect import starts Monaco's protocol and
sets `globalThis.ts`. The custom channel handles only messages with
`fhirpathSites`; Monaco handles messages with `vsWorker`.

The playground `lint()` call is asynchronous. Request IDs and model versions
discard old replies. `analyzeSite` runs on the main thread after the worker
returns the sites.

After a Monaco upgrade, confirm these details:

- `globalThis.ts` still contains the compiler;
- Monaco still ignores messages without `vsWorker` in both directions;
- `MonacoEnvironment.getWorker` still allows the application to create and keep
  the worker handle.

## `fhirpath-check`

The CLI has two separate passes:

1. the TypeScript walker finds source literals;
2. `src/cli/dto-check.ts` imports DTO modules through `src/cli/ts-loader.mjs` and
   calls `analyzeDto` on each exported DTO, which uses the engine the DTO was
   defined on.

The first pass has only source information and avoids claims it cannot prove. The
second pass can be complete because it loads the DTOs and engines.

DTO discovery uses the conventions documented in
[Static checking](docs/static-checking.md#dto-discovery). Keep these implementation
details:

- Exported classes are the only DTOs a module loader can enumerate.
- Each DTO is checked against its own engine. Checking it against a merged
  context of every engine would accept names its engine does not bind.
- The source pass still merges the declarations of the engines the imports
  construct. That recording uses a closable `recordEngines()` session around the
  imports; an always-on recording mode would retain every engine and its
  environment.
- Do not add `fhirpath.config.ts`; the checker obtains its inputs from module
  discovery and DTO declarations.

## Source analysis and loaded DTO analysis

`analyzeSite` is the only function that turns a source site into diagnostics. It
applies the source-only limits described in
[Static checking](docs/static-checking.md#source-only-limits). Keep the ESLint
rule, CLI source pass, and editor on this function so they agree.

`analyzeDto` is the loaded counterpart. It has the class, model, functions, and
environment, so it should perform the full check. Source analysis must avoid
false positives; loaded DTO analysis must not omit checks that its context can
perform.

## DTO function dispatch

The public behavior is documented in [DTOs](docs/api.md#dtos). These functions
hold the shared implementation rules:

- `unsatisfiedInput` in `src/values/type-compat.ts` decides whether a focus can
  call a typed function. Both runtime dispatch and the analyzer use it.
- `typesOverlap` decides whether two same-name declarations can be distinguished
  during DTO registration.
- `resolveByInput` chooses the first registered declaration that accepts the
  focus.
- `mergedDeclaration` in `src/analyzer/analyze.ts` widens source declarations
  when the source cannot choose one safely.

Do not copy the type compatibility rule into the analyzer or evaluator. They
must differ only in reporting: runtime code throws, while the analyzer returns
an `input-type` diagnostic.

`typesOverlap` must ask the model even when value kinds differ.
`FHIR.SimpleQuantity` is `Complex`, while `FHIR.Quantity` is `Quantity`, but the
model says that they overlap.

Built-in functions must not set `input.types`. Specification functions accept a
wide range of inputs. `src/analyzer/signatures.test.ts` checks this rule.

DTO environment values are applied in two paths: projection options and
expression-defined function calls. Both must give the DTO's own value priority
over caller values. A column can be reached through both paths during one
projection, so different precedence would give one declaration two answers.

DTO `vars` win over per-call vars for the same reason, and because
`DtoContext` infers column types from the DTO's own bindings. Keep the runtime
precedence in `dtoCallOptions` and the type-level merge in `DtoContext` equal.

DTO `vars` remain projection-only. A variable is evaluated against a row; a
registered function call has a focus but no row.

## Criteria booleans

A `this.criteria()` column registers a function with `criteria: true`. The evaluator applies
`criteriaBoolean` to its body so projection and function calls return the same
single boolean.

FHIRPath singleton evaluation returns empty for an empty collection. FHIR
constraint use adds the rule that empty has not satisfied the constraint, so the
criteria result becomes `false`.

Keep that `false` conversion in criteria handling. Do not move it into
`booleanSingleton`: three-valued `and`, `or`, `xor`, and `implies` require
`undefined` for empty input. `where`, `exists`, `all`, and `iif` keep their own
single-item tests for the same reason.

The input-type check is required for criteria functions. A criteria body called
on the wrong focus would otherwise return a plausible `false` instead of an
empty result.

## Engine-bound DTOs

A DTO or view is defined on an engine (`engine.defineDto()` /
`engine.defineView()`), and `register()` returns a derived engine. Keep these
rules together; each protects the types:

- `register()` never mutates. TypeScript fixes a value's type where it is
  declared, so only a new engine can carry the new functions in its type. There
  is no `with()`: a derived engine that could redefine an env name or the model
  would break the types of DTOs defined on its parent.
- A DTO projects on its engine or an engine derived from it (`derivesFrom`), and
  `register()` accepts only DTOs of that lineage.
- A column body reads what its definition fixed: `DtoDefinition.columnEnv` (the
  defining engine's env with the DTO's own env over it) and `columnFunctionTable`
  (the defining engine's functions with a registered DTO's own columns added
  through `declaredWith`, as `register()` adds them). `withDtos`, projection,
  and `analyzeDto` all read that one table, so a same-name column of another
  DTO stays an overload everywhere. The
  registered function carries both as overlays, and `dtoCallOptions` applies
  both over the caller's options, so per-call values never change what a
  column's type was inferred from. The function table rides under the internal
  `COLUMN_FUNCTIONS` symbol, not a public field, because the type layer does not
  model per-function tables. `defineDto()` / `defineView()` refuse a
  `callerEnv` name the engine's env binds. Engine `vars` stay out of the column
  context (`EngineColumnContext`): they are evaluated against the caller's root.
- `DtoFunctions` types registered columns from the class's field types. That is
  sound only because `assertRegistrable` rejects views, getters, and plain fields,
  and `dtoDefinition` rejects `as`/`choices` on DTO columns: a registered
  function returns the expression result, not the projected value.
- A field's TypeScript type maps back to the union of every FHIR type with that
  TypeScript form (`TypeNamesOf`). Naming one type would let `ofType()` infer
  empty where the runtime returns a value. A member no FHIR type represents
  makes the whole result undeclared; dropping it would narrow the call.
- Registered functions live in the engine's options type (`RegisteredOptions`),
  not in a second engine type parameter: measuring that parameter's variance
  taxed every engine call. Type aliases in `dto.ts` take the model maps as type
  parameters, because a concrete map in an alias body is resolved whenever the
  file is checked.

## DTO column collection

A column is a field initialized with `this.column()` or `this.criteria()`,
protected methods of `DtoBase`. The field's type comes from the method's return
type, which reads the class's `fhirType` and context from the generic base the
engine returns: the engine's context, then the DTO's `env`, `vars`, and
`callerEnv`. Keep those in the `defineDto()`/`defineView()` options: that is the
only place the column types can see them.

`dtoDefinition` constructs the class once. While `collecting` holds the class,
each column call returns a `ColumnMarker`, and the columns are the own
properties that hold one. At any other time the methods return `undefined`, so
projected rows start empty. The previous marker must already sit in a public
field when the next column is declared, and the last one at the end of
construction; that is how a column in a private field or a nested value is
reported.

`collecting` is keyed by class because collection is re-entrant: a field
initializer may construct an engine that reads another DTO definition.
`src/api/dto.test.ts` covers this case.

`column`, `criteria`, and the type-only `dtoKind` stay protected, so rows do not
expose them. The cost: an exported class extending a class returned by a user
function needs that function's return type written out when declarations are
emitted (TS4094). `ViewBaseClass<Engine, Root, Options, Fields>` exists for that
annotation; the dogfood factories use it.

The walkers read a column only in a class `dtoClassesOf` proves to be a DTO:
extending `<engine>.defineDto/defineView(...)` whose receiver is not another
package's import, directly, through a base class, or through a factory function
of the same file. The TypeScript walker also accepts a class whose `this.column`
resolves to the package's `DtoBase`. This keeps an unrelated class's own
`column()` method out of the analyzer.

## Required checks

Run the checks that match the change:

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm check:fhirpath
pnpm check:inference
pnpm check:type-perf
pnpm coverage
pnpm build
pnpm check:package
```

`scripts/type-perf-budget.json` sets the type-instantiation budget. Explain any
budget increase in the same change.

`generate:*` commands rewrite generated sources; their `check:*` variants report
drift. Precision and type-performance ratchets accept new baselines only with
`--update`; review the measurements first.

The demo has its own typecheck. Files under `demo/src/monaco/*.d.ts` are
generated; run `npm run generate:dts` in `demo/` after a public API change.

`pnpm build` and `pnpm check:package` catch problems that `pnpm typecheck` misses.
The build uses `nodenext` resolution, which matches how Node reads published
output. The root config uses bundler resolution. `check:package` resolves every
entry point's types and executes the installed tarball and CLI as a consumer. An
import that exists only as a `devDependency` passes typecheck and fails here. See
[RELEASING.md](RELEASING.md) for what the published tarball contains and why
`sideEffects` is an allowlist rather than `false`.

The checked-in `main`, `types`, `exports`, and `bin` fields point at `src` so
repository self-references never load a second copy from `dist`.
`publishConfig` mirrors those entry-point keys with paths under `dist`; pnpm
rewrites them into the tarball manifest. Keep the key-parity assertion in
`scripts/check-package.ts`, and pack with pnpm rather than npm. npm does not apply
these overrides.
