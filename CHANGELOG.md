# Changelog

Notable changes per release. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
semver — pre-1.0, a breaking change bumps the minor.

See [RELEASING.md](RELEASING.md) for how a version gets cut and published.

## Unreleased

### Added

- `engine.compile(expression, type)` declares the type a relative expression
  runs against, as the package-root `compile()` does. The result is inferred
  against that type, the input must be that type, and the static checkers
  analyze the expression against it
  ([#79](https://github.com/vintasoftware/fhirpath-ts/issues/79)).
- The static checkers analyze `new CompiledExpression('...')`.

### Changed

- **Breaking:** the optional `typescript` peer range is `>=5.4.0 <7.0.0`
  (was `>=5.0.0`). The published declarations use `NoInfer`, which TypeScript
  5.4 added, and TypeScript 5.0 already failed to check them with
  `skipLibCheck: false`. `pnpm check:package` now type-checks a consumer and
  runs the CLI with TypeScript 5.4 as well as the lockfile version.
- **Breaking:** `engine.evaluate()` and `engine.first()` type a compiled
  expression with a declared root against that root, as
  `engine.compile(expression, type)` does. This covers `compile(expression, type)`,
  `fhirpath(expression, type)`, and the `expression` of
  `engine.compile(expression, type)`. The input must be that type, an array of
  it, or a Bundle whose entries are typed as it, and the result is inferred
  against it. Before, the input was checked against the expression text only,
  which a relative expression does not root, so
  `r4.evaluate(compile('clinicalStatus', 'Condition'), patient)` compiled. A
  Patient, an `unknown` input, or a Bundle with any resource as its entries
  passed with a Condition-rooted expression is now a compile error.
- `engine.compile(expression, type)` also accepts a Bundle whose entries are
  typed as the declared type, such as Medplum's `Bundle<Condition>`.
- A compiled expression that declares its input type reads a Bundle input as
  its entries, also when it starts at a name a Bundle has too:
  `r4.evaluate(compile('id', 'Patient'), patients)` threw an ambiguity
  error and now returns the entries' ids. `CompiledExpression.inputType` holds
  the declared type, and `new CompiledExpression(expression, type)` declares
  one, which the static checkers read as they read `compile()`'s.
- `fhirpath-check` checks a relative expression in an engine call against the
  input argument's `resourceType`: `fp.first('clinicalStatus', condition)`
  with `condition: Condition` is checked against `Condition`. A path the CLI
  cannot type is reported as `[warning:unchecked-navigation]`, so `--strict`
  fails on it ([#78](https://github.com/vintasoftware/fhirpath-ts/issues/78)).
- `fhirpath-check` reads the root of `analyzeExpression(expr, { inputType })`
  from its literal `inputType` option.
- `fhirpath-check` leaves out a method call that TypeScript resolves only to
  another package or to the default library, such as
  `page.evaluate('document.title')`.

### Fixed

- The analyzer no longer reads a lowercase root identifier as a FHIR primitive
  type when the input type is unknown. `code.coding` reported `Element 'coding'
  is not defined on FHIR.code`; the runtime reads `code` as an element.
- `fhirpath-check` no longer reports a compiled expression passed to an engine
  method as skipped. Its `compile()` call is the site that is checked or
  reported ([#79](https://github.com/vintasoftware/fhirpath-ts/issues/79)).
- `engine.evaluate()` and `engine.first()` with a `{ type }` option infer the
  expression from the expression argument only. A compiled expression passed
  with an input that has a literal `resourceType`, such as
  `r4.evaluate(compile('clinicalStatus.coding.first().code', 'Condition'), condition, { type: 'code' })`,
  no longer fails to compile, and a resource-rooted expression such as
  `'Patient.name'` rejects an input of another resource type, as it does
  without `{ type }`.

## 0.4.0 - 2026-10-07

This release types what a DTO projects. `engine.project(input, Dto)` and the
new `Dto.from(input)` accept only the DTO's input, so the wrong resource type
is a compile error again
([#88](https://github.com/vintasoftware/fhirpath-ts/issues/88)); `required`
columns, `base` DTOs, code and string-literal unions in inference, and
generated interfaces that keep FHIR's required elements come with it. Three
changes are breaking: the DTO input type, the runtime rejection of a
non-resource for a resource root, and the required elements in the generated
interfaces. See [Inputs](docs/api.md#inputs) and
[Medplum types](docs/api.md#medplum-types).

### Added

- Inference returns the code union of a required binding: `Observation.status`
  infers `('registered' | 'preliminary' | ...)[]` instead of `string[]`, in
  engine calls, DTO columns, and declared environment values. An extensible
  binding such as `Reference.type` keeps inferring `string`. Runtime data is
  unchanged.
- Type inference keeps string literal text: `'a' | 'b'`, `iif(c, 'a', 'b')`,
  `combine()`, `union()`, and `coalesce()` over literals infer the literal
  union. A column such as `iif(..., 'asNeeded', 'continuous')` no longer needs
  an `enum` option to type its values.
- The type-level scanner budget rises from 64 tokens and 256 source characters
  to 128 and 512.
- `Dto.from(input, options?)`: a static on every DTO and view class that
  projects on the defining engine, typed like `engine.project()`.
- `base` option for `defineDto()` and `defineView()`: a DTO on a model base type
  such as `Resource` whose columns, `env`, `vars`, and `callerEnv` the class
  inherits (`defineDto('Condition', { base: ResourceDto })`). A DTO takes a DTO
  as base, a view a DTO or a view, and a subclass cannot rebind a name its base
  binds. A DTO on `Resource` or `DomainResource` projects any resource of that
  type, at compile time and at runtime.
- `required: true` column option for DTO and view columns on a path of singular
  element names. The input type gains the path as a required property and the
  field type drops `undefined`. There is no runtime check, and a class with a
  required column refuses a Bundle input, since an entry cannot prove the path;
  read the entries with `ofType()` and narrow them.
- `narrativeSanitizer` option and `domPurifySanitizer()` adapter. With a
  sanitizer set, `htmlChecks()` also returns `false` for a narrative the
  sanitizer would change. DOMPurify is not a dependency; pass your own instance.

### Security

- Fixed `htmlChecks()` accepting `javascript:` links written with numeric
  references that lack a `;`, such as `&#106avascript:`. A browser decodes these
  forms, so the link ran a script.
- Fixed `htmlChecks()` accepting narratives with active content hidden in a
  comment or CDATA section that an HTML parser ends early, such as
  `<!--><script>…</script>-->` or `<![CDATA[><script>…</script>]]>`. Rendered
  as HTML, the script was a live element.

### Changed

- **Breaking:** the generated R4 interfaces require the elements FHIR marks as
  required (minimum cardinality 1) and enumerate every required or extensible
  code binding the bundled definitions can, a superset of what
  `@medplum/fhirtypes` enumerates, so a datatype result such as an `Extension`,
  `Address`, or `Quantity` is assignable to the Medplum type without a cast. A
  value constructed by hand as a generated type now needs its required
  elements. Inputs stay lenient: `FhirpathInput`, the declared-root forms of
  `compile()` and `fhirpath()`, and declared host values are the
  `resourceType` pin plus the resource with every element optional, so
  `r4.evaluate('Observation.status', { resourceType: 'Observation' })` keeps
  compiling. A misspelled property or code is still rejected; a code set that
  names resources, such as `Reference.type`, accepts any string, so a Medplum
  resource is still accepted.
- **Breaking:** `engine.project(input, Dto)` types its input. A DTO or view on a
  resource type accepts `{ resourceType: '<root>' }`, an array of such values,
  or a Bundle; a datatype root accepts any object. An `unknown` input or a
  widened `resourceType: string` is a compile error, so the wrong resource type
  no longer compiles ([#88](https://github.com/vintasoftware/fhirpath-ts/issues/88)).
  `DtoInput<typeof Dto>` names the accepted input.
- **Breaking:** projecting a DTO on a resource root throws `FhirPathTypeError`
  for a value that is not an object or has no `resourceType`. Previously such a
  value projected into a row of defaults.
- The documented recipe for a mixed search Bundle is
  `r4.evaluate('Bundle.entry.resource.ofType(Patient)', bundle)`, which infers
  `Patient[]`; `filter()` on a Bundle returns `unknown[]`, which `project()` no
  longer accepts.
- The README no longer describes a `true` `htmlChecks()` result as free of
  active content. `htmlChecks()` checks the FHIR narrative rules, which are not
  an HTML sanitizer; sanitize narrative before rendering it as HTML.
- `htmlChecks()` requires well-formed XHTML. It now rejects an unclosed `<br>`,
  uppercase element names, attributes without a value or without whitespace
  between them, duplicate attributes, a bare `&`, characters XML does not allow,
  and an `xmlns` other than the XHTML namespace.
- `htmlChecks()` returns `false` for a narrative without non-whitespace text or
  an image, as FHIR invariant `txt-2` requires. `txt-2` uses `htmlChecks()` as
  its expression in R4 and R5.
- `htmlChecks()` checks a string, including a model subtype of `string` such as
  `markdown` or `code`, as the content of a narrative `div`, as the current FHIR
  build specifies (FHIR-56303); an `xhtml` element is still checked
  as the whole `div`. Without a model, `text.div` is a string, so it is now
  checked as `div` content instead of as the whole `div`. It returns an empty
  collection for other item types and for collections, instead of `false` or an
  error. The analyzer no longer reports `singleton-required` for it.

### Fixed

- Fixed `replaceMatches()` to substitute PCRE-style group references such as
  `${day}` and `${1}`, as in the specification's example. A custom `regex`
  engine receives them rewritten to `$<day>` and `$01`.

## 0.3.0 - 2026-09-26

This release replaces the DTO API. DTOs from 0.2.x need to be rewritten; see
[DTOs](docs/api.md#dtos) for the new API.

### Changed

- **Breaking:** DTO columns are class fields initialized with `this.column()` or
  `this.criteria()` instead of decorated properties. Each field's type is
  inferred from its expression, the class `fhirType`, and the DTO's `env`,
  `vars`, and `callerEnv`. A declared field type is checked against the
  inferred type.
- **Breaking:** DTOs and views are defined on an engine with
  `engine.defineDto()` and `engine.defineView()`. `defineDto()` is for DTOs meant
  for registration (columns and methods only). `defineView()` is for projected
  rows, which may also hold getters, plain fields, and `as`/`choices`
  conversions.
- **Breaking:** `engine.register(...dtos)` returns a new engine and leaves the
  original unchanged. Registered columns are typed expression functions in
  engine calls and in the columns of DTOs and views defined on the new engine.
  `register()` accepts only DTOs defined on that engine or on an engine it was
  derived from.
- **Breaking:** DTO `env` moves into the `defineDto()`/`defineView()` options.
  A name in both `env` and `callerEnv`, or a `callerEnv` name the engine's env
  binds, is rejected.
- **Breaking:** DTO `vars` win over per-call vars, matching `env`.
- Column bodies see the engine's env and typed host functions, and always call
  the functions their types were inferred from, whatever per-call options are
  passed.
- `analyzeDto()` and `fhirpath-check` check each DTO against its own engine
  instead of against the merged context of every discovered engine.
- The ESLint rule and the TypeScript site walker read columns in classes that
  extend `<engine>.defineDto/defineView(...)`, including through same-file base
  classes, factory functions, imported engines, and engines derived with
  `register()`.
- DTOs no longer use decorators, so they compile with any TypeScript or
  JavaScript toolchain.

### Added

- Added the `DtoBaseClass`, `ViewBaseClass`, `DtoColumnOptions`, `DtoContext`,
  `DtoFunctions`, `DtoKind`, `RegisteredDtoClass`, `RegisteredOptions`, and
  `EngineDtoContext` types.

### Removed

- **Breaking:** Removed the standalone `defineDto()`, `column`, and `criteria`
  exports; `static env`; the `resourceDtos` engine option; and the `DtoEnv`,
  `DtoInstance`, and `ColumnTypeMismatch` types.

### Fixed

- Fixed type inference returning `never` for an expression that calls a host
  function with no body or result type; it now returns `unknown[]`.
- Fixed `analyzeDto()` reporting false errors when a DTO's env or vars shared a
  name with a typed engine variable.

## 0.2.3 - 2026-09-21

### Fixed

- Fixed ordering comparisons involving FHIR primitives without values to return
  an empty collection.
- Fixed `join()` on an empty collection to return an empty collection.

### Changed

- Updated the official R5 conformance suite with tests for primitives without
  values and restored the passing R4 `testIif6` case under strict mode.
- Updated the official R4 and R5 suites with `split()` and `join()` edge cases.

## 0.2.2 - 2026-08-22

### Added

- Added collection-order inference to analyzer results and custom function
  declarations. Strict analysis now rejects position-dependent operations on
  collections known to be unordered.

### Changed

- Expanded `fhirpath-check` source analysis to resolve imported, aliased, and
  re-exported engines; carry environment and variable context into expressions;
  and report dynamic expressions or unloaded DTOs that could not be checked.
- Made `fhirpath-check` use the nearest `tsconfig.json` for each selected source
  file, so packages with different path mappings can be checked together.
- Updated GitHub Actions to their current Node 24-based major versions.

### Fixed

- Fixed false checker diagnostics around computed keys, object spreads, dynamic
  options, variable precedence, aliased DTO exports, and partial TypeScript
  configurations.
- Fixed loaded analysis combining engines backed by different model providers;
  the checker now reports the incompatible configuration instead of using the
  wrong model.

## 0.2.1 - 2026-08-18

### Changed

- Shipped the bundled R4 model as compact strings decoded on demand. An element
  identical to the nearest ancestor's is stored once instead of in every type
  that inherits it. The minified `fhirpath-ts/r4` bundle went from 427 KB to
  287 KB, its import from 31 ms to 11 ms, and 200k element lookups from 47 ms
  to 27 ms.
- Sorted the result of `listElements`, so its order no longer depends on which
  type in the inheritance chain declares each element.

## 0.2.0 - 2026-08-17

### Added

- Added opt-in strict evaluation through engine defaults or per-call options.
  Strict mode runs the analyzer with the runtime model, functions, environment,
  variables, and input types before evaluating an expression.
- Replaced path-segment type inference with a bounded type-level parser covering
  literals, operators, built-in functions, lambda scope, variables, reference
  targets, and declared host context. Greater inference coverage achieved.
- Added `envTypes` and `varTypes` declarations plus public inference helper types
  for engine, compiled-expression, and projection APIs.

### Changed

- Reduced the published package by excluding generated inference verification
  artifacts while retaining the metadata required by consumers.
- Expanded the documentation for evaluation errors, lenient and strict
  navigation, DTO import behavior, DTO file naming, and type-inference limits.

### Fixed

- Fixed inference for aggregate initializers, wrapped Bundle projections,
  compiled custom-function bodies, reusable option objects, and environment
  values.
- Fixed loaded DTO analysis so unregistered DTOs receive the complete merged
  environment and variable context from discovered engines.

## 0.1.0

First published release.
