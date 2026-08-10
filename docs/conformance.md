# Conformance

The test suite checks official FHIRPath behavior, error phases, static analysis,
and known differences from other implementations.

## Official suites

The R4 and R5 suites from
[FHIR/fhir-test-cases](https://github.com/FHIR/fhir-test-cases) are stored in the
repository, converted to JSON offline, and run with Vitest.

| Suite | Passing | Skipped with a reason | Failing |
| --- | ---: | ---: | ---: |
| R4 (`tests-fhir-r4.xml`) | 923 | 12 | 0 |
| R5 (`tests-fhir-r5.xml`) | 1,026 | 25 | 0 |

Every non-skipped official case passes.

Invalid cases must fail in the phase named by the suite:

- `invalid="syntax"` throws `FhirPathSyntaxError` while parsing;
- `invalid="semantic"` throws `FhirPathTypeError`;
- `invalid="execution"` throws a runtime or type error during evaluation.

Six intentional phase differences are recorded in the checked
`PHASE_OVERRIDES` list.

The static analyzer runs a separate pass over both official suites. Every
strict-mode and semantic-invalid case must report an error diagnostic. Every
valid case must report none.

## Skipped official cases

Every skip is listed in `test-data/official/skip-manifest.ts`. A maintenance test
fails when a skip no longer matches a suite case.

| Category | Reason |
| --- | --- |
| Terminology mode | Needs a terminology service |
| CDA mode | Needs a CDA `ModelProvider` |
| Lenient polymorphics | Profile-dependent mode that this engine does not offer |
| Strict-mode static checks | Covered by the analyzer conformance pass instead of evaluation |
| R5-only elements | The package currently ships an R4 model |
| Decimal boundary and dateTime millisecond cases | Expected values conflict with the mathematical bounds; recorded as upstream test issues |
| `testIif6` and `testPlusDate19` in R4 | R5 changed ambiguous R4 behavior; the engine follows R5 |

The manifest contains the exact case names and evidence.

## Reference test corpora

The package also runs tests from
[HL7/fhirpath.js](https://github.com/HL7/fhirpath.js) and
[beda-software/fhirpath-py](https://github.com/beda-software/fhirpath-py).

| Corpus | Passing | Skipped with a reason |
| --- | ---: | ---: |
| fhirpath.js cases plus fhirpath-py additions | 2,289 | 1,380 |

Most skips require a model other than R4 or are disabled upstream. Another 241
cases are intentional differences recorded in
`test-data/fhirpathjs/quirk-manifest.ts`. Each group includes its specification or
official-suite evidence. Maintenance tests keep the entries exact.

The fhirpath-rs corpus was also reviewed. Its official R5 cases are already
covered by the official suite. Its additional cases are included in
`src/reference-crosschecks.test.ts`, together with selected Medplum comparisons.

## Property and differential tests

Generated tests cover behavior that a fixed example list may miss:

- parser and printer round trips over generated ASTs;
- exact-decimal arithmetic properties;
- temporal comparison properties across mixed precision;
- generated expressions evaluated by both this engine and fhirpath.js against
  the official Patient fixture.

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
