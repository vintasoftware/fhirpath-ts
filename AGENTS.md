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
cost.

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
   calls `analyzeDto` with the discovered engine context.

The first pass has only source information and avoids claims it cannot prove. The
second pass can be complete because it loads the DTOs and engines.

DTO discovery uses the conventions documented in
[Static checking](docs/static-checking.md#dto-discovery). Keep these implementation
details:

- Exported classes are the only DTOs a module loader can enumerate.
- Engine discovery uses a closable `recordEngines()` session around the imports.
  An always-on recording mode would retain every engine and its environment.
- A missing engine makes unresolved column calls warnings, not errors.
- An unregistered DTO is checked once against the merged context of all engines.
  Checking each engine and keeping the quietest answer would hide errors.
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

DTO `vars` remain projection-only. A variable is evaluated against a row; a
registered function call has a focus but no row.

DTO `vars` take priority over same-name caller vars during projection. Decorator
inference reads the DTO expression, so allowing a caller to replace that binding
could make the projected runtime value disagree with the declared field type.
Use caller `env` to parameterize a DTO var.

## Criteria booleans

`@criteria` registers a function with `criteria: true`. The evaluator applies
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

## DTO decorator collection

Standard field decorators record their class through the initializer they
return. `dtoDefinition` creates one instance while `collecting` identifies the
class being read.

Collection can be re-entrant: a field initializer may construct an engine that
reads another DTO definition. Save and restore the previous `collecting` value
around each read. Clearing it after the inner read would stop collection for the
outer class. `src/api/dto.test.ts` covers this case.

The repository lowers standard decorators through the TypeScript transform in
`vitest.config.ts`. Keep its target at ES2022. An `esnext` target leaves
decorators in the output, which Node cannot import in this setup. The demo uses
the same target in Monaco.

Legacy `experimentalDecorators` cannot check a field's declared value type
against the inferred column type, so this project uses standard decorators.

`defineDto()` keeps its literal options in a type-only brand on the returned
base. Field decorators read that brand so DTO `vars` and projection row bindings
participate in column inference. Keep the brand off `fhirType` so its literal
type stays public, and do not add runtime fields to projected rows.

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
