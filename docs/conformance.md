# Conformance

The engine follows [FHIRPath 3.0.0](https://hl7.org/fhirpath/STU3/). The test
suite checks official FHIRPath behavior, error phases, static analysis, and known
differences from other implementations.

## Official suites

The R4 and R5 suites from
[FHIR/fhir-test-cases](https://github.com/FHIR/fhir-test-cases) are stored in the
repository, converted to JSON offline, and run with Vitest.

| Suite | Passing | Skipped with a reason | Failing |
| --- | ---: | ---: | ---: |
| R4 (`tests-fhir-r4.xml`) | 940 | 7 | 0 |
| R5 (`tests-fhir-r5.xml`) | 1,062 | 13 | 0 |

Every non-skipped official case passes.

Invalid cases must fail in the phase named by the suite:

- `invalid="syntax"` throws `FhirPathSyntaxError` while parsing;
- `invalid="semantic"` throws `FhirPathTypeError`;
- `invalid="execution"` throws a runtime or type error during evaluation.

Four intentional phase differences are recorded in the checked
`PHASE_OVERRIDES` list.

Semantic-invalid and strict-mode cases run through strict evaluation. The static
analyzer also runs a separate pass over both official suites. Every
semantic-invalid case it supports must report an error diagnostic, while valid
cases must report none. Execution-invalid cases must parse: the analyzer reports
no syntax diagnostic for them, apart from the phase overrides.

## Skipped official cases

Every skip is listed in `test-data/official/skip-manifest.ts` with a category:
a different FHIR version or model, an intentional divergence, or a deferred
feature. Test titles name the category. No official case is skipped as a
deferred feature. A maintenance test fails when a skip no longer matches
a suite case.

| Cases | Category | Reason |
| --- | --- | --- |
| CDA mode | Different FHIR version or model | Needs a CDA model; the package ships the FHIR R4 model |
| R5-only elements | Different FHIR version or model | The package currently ships an R4 model |
| `testPlusDate19` in R4 | Different FHIR version or model | R5 changed ambiguous R4 behavior; the engine follows R5 |
| Lenient polymorphics | Intentional divergence | FHIRPath reads a choice element by its base name; the suite pins suffixed keys such as `valueQuantity` as errors outside lenient mode (`testPolymorphismB`) |
| Decimal boundary and dateTime millisecond cases | Intentional divergence | Expected values conflict with the mathematical bounds; recorded as upstream test issues |
| `testSort10` | Intentional divergence | Expects an empty sort key first in descending order; FHIRPath 3.0.0 sorts it last |

The manifest contains the exact case names and evidence. Entries marked
`runtimeOnly` dispute an expected value, not a feature. The analyzer pass still
runs those cases, because it checks diagnostics and not values.

## Recorded terminology services

Tests that need a terminology service replay recorded answers, so the suite runs
offline. The official tx-mode cases replay tx.fhir.org answers from
`test-data/official/r5/tx-fixtures.json` (`pnpm record:tx`). The cases in
`src/testing/medplum-terminology.ts` replay a Medplum server's answers from
`test-data/terminology/medplum.json` (`pnpm record:tx:medplum`). They cover
`memberOf()`, Boolean subsumption, every `%terminologies` operation, and
CodeSystem `weight()` lookup.

Both recorders capture the engine's provider calls and the FHIR answers, not
HTTP traffic, so credentials never reach a recording. The Medplum recorder
creates a synthetic scored CodeSystem and ConceptMap for the recording, then
deletes them. It strips server bookkeeping from the answers and refuses to write
a recording that contains its credentials, access token, project id, or server
host. Record with a client of a project that holds only synthetic data.

## Reference test corpora

The package also runs tests from
[HL7/fhirpath.js](https://github.com/HL7/fhirpath.js) and
[beda-software/fhirpath-py](https://github.com/beda-software/fhirpath-py).

| Corpus | Passing | Skipped with a reason |
| --- | ---: | ---: |
| fhirpath.js cases plus fhirpath-py additions | 1,439 | 246 |

The corpus's copies of the official suites (`fhir-r4.yaml` and `fhir-r5.yaml`)
are left out: `official.test.ts` runs those suites directly, with their modes
and predicates, and a maintenance test checks that every copied case is in them.
Other cases disabled upstream run here. The skips, by category:

- 92 need another FHIR version or model: 17 run with the R5 model, 9 STU3, 9
  DSTU2, and 57 use the `%factory` API. `%factory` is not in
  [FHIR R4's FHIRPath page](https://hl7.org/fhir/R4/fhirpath.html); FHIR R5 adds
  it in section 2.1.9.3, "Type Factory", as a draft (maturity 0).
- 154 are intentional differences, including four disabled upstream whose
  expected result is wrong.

fhirpath.js's `{ base, expression }` cases run with the input typed by
`toTyped(input, base)`.

`test-data/fhirpathjs/quirk-manifest.ts` lists the version differences,
intentional differences, and deferred features by family, each with its
evidence. A maintenance test runs every listed case and fails when one starts
passing, so the manifest lists only differences that still exist.

The fhirpath-rs corpus was also reviewed. Its official R5 cases are already
covered by the official suite. Its additional cases are included in
`src/reference-crosschecks.test.ts`, together with selected Helios (hfs) and
Medplum comparisons and the FHIRPath 3.0.0 cases from Josh Mandel's
hand-written fhirpath.zig tests. Three fhirpath-rs `repeatAll()` cases expect
the input items in the output, or a constant projection to end; that file tests
the specification's behavior instead.

`src/crosschecks-3.0.0.test.ts` runs 179 FHIRPath 3.0.0 cases from
[gofhir/fhirpath](https://github.com/gofhir/fhirpath),
[Pathling](https://github.com/aehrc/pathling),
[Ignixa](https://github.com/brendankowitz/ignixa-fhir), and the fhirpath.js
`pathname()` and instance selector tests. `test-data/crosschecks/README.md`
lists their sources and commits.

## Deviations from the specification

`union()`, `|`, and `combine()` keep the order of their sources: the input's
items, then the argument's. FHIRPath 3.0.0 gives `union()` no order, and
`combine()` an order only when its `preserveOrder` argument is `true`. The
runtime appends in order either way, and the analyzer treats these results as
ordered, so `(a | b).first()` and `a.combine(b).first()` are not
`order-dependent` errors. Reading them as unordered would reject many common
expressions that rely on that order.

`sort()` also accepts a key written as `-key`, which sorts `key` descending, as
`key desc` does. FHIRPath 3.0.0 describes only the `asc` and `desc`
qualifiers; the official R4 and R5 suites use the `-key` form. With a qualifier, a leading minus is plain negation:
`sort(-$this desc)` sorts numbers ascending.

## Property and differential tests

The dated [SDC readiness assessment](sdc-readiness.md) compares this engine
with fhirpath.js on Smart Forms' own tests and on selected LHC-Forms cases. Its
runner stays outside the repository; the offline probes run with
`pnpm exec vitest run dogfood/sdc`.

Generated tests cover behavior that a fixed example list may miss:

- parser and printer round trips over generated ASTs;
- exact-decimal arithmetic properties;
- temporal comparison properties across mixed precision;
- generated expressions evaluated by both this engine and fhirpath.js against
  the official Patient fixture.
- generated narratives, mixing valid XHTML with forms that XML and HTML parse
  differently: every narrative `htmlChecks()` accepts must also contain only
  allowed elements, attributes, and inert URLs when parsed by parse5, which
  follows the HTML parsing algorithm browsers use.

The comparison follows the specification and official suite when another engine
has different behavior. For example, this engine does not treat one month as 30
days, and `(0).not()` follows the official boolean rules.

## Upstream changes

`.github/workflows/drift-watch.yml` runs weekly. It downloads the current
`FHIR/fhir-test-cases` source, converts the suites, and reports any changed or new
cases. The generated diff is attached to the workflow run.

To refresh the committed data manually:

```bash
node scripts/convert-official-tests.ts
```

Review every changed case and update a manifest only when the skip or difference
still has a clear reason.

## Coverage

Vitest enforces these minimums:

| Metric | Minimum |
| --- | ---: |
| Statements | 99% |
| Branches | 96% |
| Functions | 99.5% |
| Lines | 99% |

Uncovered lines are limited to defensive branches for invalid internal states
and data shapes that the supported FHIR models do not produce.

## Related documents

- [Static checking](static-checking.md) explains the analyzer and its tools.
- [Engine comparison](engine-comparison.md) compares features and correctness
  practices across implementations.
- [Gaps and deferred features](../README.md#gaps-and-deferred-features) lists
  unsupported behavior.
