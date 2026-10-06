# Changelog

Notable changes per release. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
semver — pre-1.0, a breaking change bumps the minor.

See [RELEASING.md](RELEASING.md) for how a version gets cut and published.

## Unreleased

### Security

- Fixed `htmlChecks()` accepting `javascript:` links written with numeric
  references that lack a `;`, such as `&#106avascript:`. A browser decodes these
  forms, so the link ran a script.
- Fixed `htmlChecks()` accepting narratives with active content hidden in a
  comment or CDATA section that an HTML parser ends early, such as
  `<!--><script>…</script>-->` or `<![CDATA[><script>…</script>]]>`. Rendered
  as HTML, the script was a live element.

### Changed

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
