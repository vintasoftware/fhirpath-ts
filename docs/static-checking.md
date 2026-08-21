# Static checking

[FHIRPath specification §11](https://hl7.org/fhirpath/en/index.html#type-safety-and-strict-evaluation)
defines type safety and strict evaluation rules. This package applies them before expressions
run through TypeScript inference, an ESLint rule, a CLI, a public analyzer API,
and opt-in strict evaluation.

## Strict evaluation

Set `strict: true` on `FhirPathEngine` or an individual evaluation call to run
the analyzer with the evaluator's model, functions, environment, variables, and
runtime input type. Every error diagnostic becomes a `FhirPathTypeError` before
the expression runs. Analyzer warnings remain non-fatal.

```ts-invalid
const fp = new FhirPathEngine({ model: r4Model, strict: true })
fp.evaluate('Patient.name.givenn', patient) // FhirPathTypeError: unknown-element
```

This is useful when expressions arrive dynamically and cannot be checked by the
CLI or ESLint. A model is required to validate FHIR members. The default remains
lenient so ordinary navigation keeps FHIRPath's empty-collection behavior.

## The three layers

### TypeScript inference

Literal expressions use a bounded type-level parser that follows the runtime
grammar. They infer result and input types in plain `tsc`; no compiler plugin is
required.

```ts
const names = r4.compile('Patient.name.given')
names.evaluate(patient) // string[]; input must be a Patient
```

The parser covers literals, operators and precedence, paths, built-in functions,
lambda scope, variables, generated Reference targets, and declared host context.
A construct remains `unknown[]` when its result cannot be expressed safely.

Malformed, dynamically widened, and deliberately opaque expressions also become
`unknown[]`, not TypeScript errors. Use the analyzer to report expression errors.

The type-level scanner accepts at most 64 emitted tokens and 256 visited source
characters. Crossing either limit returns `unknown[]`; runtime evaluation and
the analyzer still accept the full expression.

Tagged templates are also `unknown[]` because TypeScript does not preserve their
literal types. Use `fhirpath('...')` or `compile('...')` for inference.

### ESLint

The ESLint rule analyzes literal expressions where they are written:

```js
import fhirpathPlugin from 'fhirpath-ts/eslint'

export default [
  {
    plugins: { fhirpath: fhirpathPlugin },
    rules: {
      'fhirpath/no-invalid-expressions': 'error',
    },
  },
]
```

It recognizes:

- `fhirpath`, `compile`, `evaluate`, `evaluateTyped`, `first`, and
  `analyzeExpression` calls;
- `FhirPathEngine` and `r4` methods such as `test`, `filter`, `project`, and
  `checkConstraints`;
- `@column`, `@criteria`, and `defineDto()` expressions;
- the `fhirpath` tagged template.

Common method names are checked only on values imported from this package or
created as a `FhirPathEngine`. This avoids reading an unrelated `.filter()` or
`.first()` call as FHIRPath.

By default, the rule trusts imports from `fhirpath-ts` and bare API names. The
options can extend that scope:

- `packages` adds other import-source prefixes that expose this API;
- `localImports: true` includes relative imports, which is useful when a project
  consumes the package from source;
- `variables` declares environment names and optional types;
- `functions` declares functions that are not visible in the current source
  file.

This repository uses the rule on its own source. See `eslint.config.ts` for a
complete configuration.

### CLI

`fhirpath-check` uses the same analyzer without requiring ESLint. Install
TypeScript in the consuming project because the CLI uses it to read source and
load DTO modules.

```sh
pnpm exec fhirpath-check "src/**/*.ts"
```

The command checks two sources:

1. expression literals found in the selected TypeScript files;
2. exported DTO classes loaded from `*.dto.ts` files.

Use `--no-import` for the source-only pass:

```sh
pnpm exec fhirpath-check --no-import "src/**/*.ts"
```

The CLI asks TypeScript for the resolved receiver type, so an engine imported,
aliased, or re-exported through a local module is recognized as a
`FhirPathEngine`. It reads the nearest `tsconfig.json`, resolves `extends` and
`paths` from the config file's own directory, and layers the declared options
over its defaults — `allowJs`, `skipLibCheck`, and NodeNext module resolution
unless the config declares its own `module` or `moduleResolution`. If a project
cannot be type-resolved, `--local-imports` applies the broader syntax-only
policy that trusts relative imports.

Calls that look like supported expression sites but cannot be read are reported
as `[warning:skipped]`. This includes dynamic strings, interpolated templates,
and receivers whose engine type cannot be established. `--strict` promotes
warnings to errors. A successful run with warnings says `no errors found`, not
`no problems found`.

Literal `vars` expressions in `EvaluateOptions` are checked in declaration
order on every supported engine call. Each expression sees the call environment
and earlier vars; projection vars also see `%rowIndex` and `%rowTotal`.

Inline `env` and `vars` keys declare the variable names an expression may use.
A computed string-literal key (`['name']: …`) reads like a plain one. A
construct that binds names the source cannot list — another computed key, a
spread, or a non-literal options object — opens the call's variable scope from
where it binds. An unresolved `%variable` at an open-scope site may exist at
runtime, so it is reported as `[warning:unchecked-variable]` instead of an
unknown-variable error; `--strict` promotes it like any other warning.

The command exits with a non-zero status when it reports an error diagnostic.
Warnings, such as possible regular expression backtracking, do not fail the run.

For a pre-commit hook, check only staged source files with `--no-import`. Run the
DTO import pass in CI, where module initialization is expected.

```json
{
  "lint-staged": {
    "*.ts": ["fhirpath-check --no-import"]
  }
}
```

## DTO discovery

The CLI finds DTOs by convention:

- DTO modules use the `*.dto.ts` suffix by default. Repeat `--dtos "<glob>"` to
  use another location.
- DTO classes must be exported because a module loader can inspect only
  exports — directly, through an exported alias (`export const Row =
  ProblemRow`), or through an exported subclass.
- Engines do not need to be exported. The checker records engines created while
  it imports the selected DTO modules.
- Put engines in the selected modules or include their modules in `--dtos`.

Importing a DTO module executes its top-level code, decorator and class
initialization, and imported dependencies. Keep selected DTO modules and their
imports free of unexpected side effects, and run the import pass only on trusted
project code. Use `--no-import` when module execution is not appropriate.

The loaded DTO check has the engine's real model, registered functions, and
environment names. It can resolve calls between DTO columns and compare declared
column types with the analyzer result. Those merged engine declarations also
feed the source pass, so a misspelled environment variable is reported when the
import pass knows the complete environment.

When no engine is found, the CLI cannot resolve column-to-column calls. It
reports that limit as a warning and keeps the run successful.

A DTO that is not registered with an engine is checked against the merged
context of all discovered engines. This answers whether some engine in the
project defines a name. The project does not need a `fhirpath.config.ts`.

Multiple engines are supported, but merged analysis requires them to share one
`ModelProvider` instance — a source literal does not say which engine will run
it, so declarations analyzed under another engine's type hierarchy would
produce wrong findings. Engines with different models, or one with a model and
one without, make the CLI exit with a configuration error; check projects with
genuinely different model families in separate runs. A DTO registered to an
engine is always analyzed against its own engine's model.

Declare per-call environment names or types on the DTO itself:

```ts
export class LabRow extends defineDto('ServiceRequest', {
  callerEnv: { reports: { type: 'DiagnosticReport', collection: true } },
  vars: { report: "%reports.where(basedOn.reference = 'ServiceRequest/' + %context.id).first()" },
}) {
  // columns
}
```

Vars are checked in declaration order, and each var's inferred type carries
into the vars and columns after it. Here `%reports` is declared as a
`DiagnosticReport` collection, so `%report` is inferred as a single
`DiagnosticReport` and every column path through it is checked.

A name-only declaration (`callerEnv: ['reports']`) provides no type. Paths
through such a value cannot be verified, and each one is reported as
`[warning:unchecked-navigation]`.

A DTO class that a matched module does not export is reported as
`[warning:unloaded-dto]`. The import pass cannot load it, so its full check
cannot run. Export the class, an alias to it, or a class that extends it.

## Source-only limits

Source analysis avoids a diagnostic when the source does not contain enough
information to prove an error.

- A DTO column may receive `%vars` from a base class or from `project()`, so
  source-only checks do not report unknown variables on DTO sites.
- A function declared by a DTO in another module is not visible. An unresolved
  function is reported only when its name is close to a column declared in the
  same file.
- A DTO needs a statically known `fhirType` for element and type checks. Its own
  `extends defineDto('Type')` or a base class declared in the same file provides
  that type. A factory call or imported base class receives syntax checks only.
- An engine reached through an alias the file does not declare, such as
  `this.engine` or a function parameter, needs TypeScript type information to be
  recognized. The CLI builds a TypeScript program for this. Editors parse one
  file at a time and skip such receivers.

Use `analyzeDto()` in a test or the CLI import pass when full runtime context is
needed.

## Public analyzer

Use `analyzeExpression()` for editors, tests, and services that accept
expressions:

```ts-invalid
import { analyzeExpression } from 'fhirpath-ts/analyzer'
import { r4Model } from 'fhirpath-ts/r4'

const diagnostics = analyzeExpression('name.givenn', {
  model: r4Model,
  inputType: 'Patient',
})
```

The analyzer checks:

- syntax;
- unknown elements, functions, types, and environment variables;
- function arity;
- singleton requirements on inputs, operands, and arguments;
- operand, argument, and function-input types;
- comparisons that cannot match;
- order-dependent operations on collections known to be unordered;
- choice-key misuse such as `Observation.valueQuantity`;
- regular expression literals that may have catastrophic backtracking.

Each fact stays unknown until the analyzer can prove it. For example,
`children()` and `descendants()` have unknown result types and cardinality but a
known undefined order, while an undeclared `%var` also has unknown ordering. The
rejected operations are the ones that select items by position — the indexer,
`first()`, `last()`, `tail()`, `skip()`, and `take()` — and only on a collection
known to be unordered. Functions whose result merely varies with iteration
order, such as `join()` and `aggregate()`, are not rejected.

Declare host variables and functions so the analyzer can check their use:

```ts
analyzeExpression('%limit < value.count()', {
  model: r4Model,
  inputType: 'Observation',
  variables: {
    limit: { types: ['System.Integer'], single: true },
  },
  functions,
})
```

Set `reportUnchecked: true` to receive warning diagnostics when navigation starts
from a declared variable with no type. The CLI enables this coverage check. It
is opt-in for direct analyzer callers because an untyped variable may
intentionally hold arbitrary non-FHIR objects.

A variable declaration may also set `ordered: false` when the host supplies a
collection with no defined order; the analyzer then rejects positional
operations on it. Omitting `ordered` keeps the ordering unknown.

`analyzeDto()` checks one DTO with an engine or explicit analyzer options.
`analyzeEngineDtos()` checks all DTOs registered on an engine.

## Shared expression-site rules

The ESLint rule walks ESLint's ESTree. The CLI, playground, and other tools walk
the TypeScript AST through `fhirpath-ts/sites`. The TypeScript namespace is
supplied by the caller, so importing the package does not add a runtime
TypeScript dependency.

Both walkers use the same expression-site policy and send sites through
`analyzeSite()`. A shared test corpus compares their positions, context, and
diagnostics.

## Conformance of the checker

The analyzer runs over the official R4 and R5 suites. Every strict-mode and
semantic-invalid case must report an error. Every valid case must report none.
This checks both error detection and false positives.

See [Conformance](conformance.md) for suite counts and maintenance details.
