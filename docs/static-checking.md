# Static checking

FHIRPath specification §11 defines type safety and strict evaluation rules. This
package applies them before expressions run through TypeScript inference, an
ESLint rule, a CLI, and a public analyzer API.

## The three layers

### TypeScript inference

Literal expressions infer result and input types in plain `tsc`. No compiler
plugin is required.

```ts
const names = r4.compile('Patient.name.given')
names.evaluate(patient) // string[]; input must be a Patient
```

Inference covers common paths and functions, including:

- dotted paths, indexes, groups, and unions;
- choice stems;
- `where()`, `select()`, `first()`, `last()`, `single()`, `tail()`, `skip()`,
  `take()`, `distinct()`, `exclude()`, `intersect()`, and `trace()`;
- `ofType()` and `as()`;
- boolean, comparison, existence, count, numeric, conversion, and string
  functions with fixed result types;
- `%var` roots when a fixed-result function ends the chain.

An expression outside this subset becomes `unknown[]`. It does not become a
TypeScript error. Use the analyzer for the full language.

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
- DTO classes must be exported because a module loader can inspect only exports.
- Engines do not need to be exported. The checker records engines created while
  it imports the selected DTO modules.
- Put engines in the selected modules or include their modules in `--dtos`.

The loaded DTO check has the engine's real model, registered functions, and
environment names. It can resolve calls between DTO columns and compare declared
column types with the analyzer result.

When no engine is found, the CLI cannot resolve column-to-column calls. It
reports that limit as a warning and keeps the run successful.

A DTO that is not registered with an engine is checked against the merged
context of all discovered engines. This answers whether some engine in the
project defines a name. The project does not need a `fhirpath.config.ts`.

Declare per-call environment names on the DTO itself:

```ts
export class LabRow extends defineDto('ServiceRequest', {
  callerEnv: ['reports'],
  vars: { report: '%reports.where(orderId = %context.id).report' },
}) {
  // columns
}
```

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
- An engine stored behind an untracked alias, such as `this.engine` or a function
  parameter, is not recognized as a package API receiver.

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
- choice-key misuse such as `Observation.valueQuantity`;
- regular expression literals that may have catastrophic backtracking.

Unknown regions remain unknown until narrowed. Examples include `children()`,
`descendants()`, an untyped `resolve()`, and undeclared `%vars`. This follows §11
and prevents incorrect diagnostics.

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

`analyzeDto()` checks one DTO with an engine or explicit analyzer options.
`analyzeEngineDtos()` checks all DTOs registered on an engine.

## Shared expression-site rules

The ESLint rule walks ESLint's ESTree. The CLI, playground, and other tools use
`createSiteFinder(ts)` from `fhirpath-ts/sites` to walk the TypeScript AST. The
TypeScript namespace is supplied by the caller, so importing the package does
not add a runtime TypeScript dependency.

Both walkers use the same expression-site policy and send sites through
`analyzeSite()`. A shared test corpus compares their positions, context, and
diagnostics.

## Conformance of the checker

The analyzer runs over the official R4 and R5 suites. Every strict-mode and
semantic-invalid case must report an error. Every valid case must report none.
This checks both error detection and false positives.

See [Conformance](conformance.md) for suite counts and maintenance details.
