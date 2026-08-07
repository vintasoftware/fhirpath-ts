# Changelog

Notable changes per release. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
semver — pre-1.0, a breaking change bumps the minor.

See [RELEASING.md](RELEASING.md) for how a version gets cut and published.

## Unreleased

### Added

- The package is published to npm. `main`, `types`, `exports` and `bin` point at
  a `tsc`-built `dist`; the tarball carries `dist`, `src` (for sourcemaps) and the
  licence files, and nothing else.

### Fixed

- `fhirpath-check` found no DTOs in this repo's own `dogfood/` directory. Modules
  that import the library by package name self-resolve through `exports`, so they
  loaded a second copy of the library whose engine registry the checker could not
  see. See "The `fhirpath-ts-source` condition" in
  [RELEASING.md](RELEASING.md).

### Changed

- `fhirpath-ts/sites` types its `createSiteFinder(ts)` argument from a default
  import of `typescript` rather than a namespace import. Under Node's ESM
  resolution a namespace import of `typescript` carries a synthetic `default`
  property that a caller's own `import ts from 'typescript'` does not, so the old
  type rejected the value callers actually pass.
- The `typescript` optional peer range is now `>=5.0.0 <7.0.0`. The native port's
  `typescript` entry point does not export the compiler API, so `fhirpath-check`
  and `fhirpath-ts/sites` cannot run against it.

## 0.1.0

First published release.
