# Changelog

Notable changes per release. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
semver — pre-1.0, a breaking change bumps the minor.

See [RELEASING.md](RELEASING.md) for how a version gets cut and published.

## Unreleased

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
