# FHIRPath 3.0.0 cross-checks

`fhirpath-3.0.0.json` holds cases from other engines' test suites for the
functions and syntax FHIRPath 3.0.0 added: regex flags, `repeatAll()`,
`duration()` and `difference()`, date formats, `pathname()`, instance
selectors, and `combine()`'s `preserveOrder`. `src/crosschecks-3.0.0.test.ts`
runs them.

| Source | Files | Commit | License |
| --- | --- | --- | --- |
| [gofhir/fhirpath](https://github.com/gofhir/fhirpath) | `temporal_difference_test.go`, `default_offset_reach_test.go`, `regex_flags_test.go`, `scoped_functions_test.go` | `ee6e131b49a1f607f5576c1a0cc154756a457ebc` | `LICENSE-gofhir.md` (MIT) |
| [aehrc/pathling](https://github.com/aehrc/pathling) | `fhirpath/src/test/java/au/csiro/pathling/fhirpath/dsl/RepeatAllFunctionDslTest.java`, `CombiningFunctionsDslTest.java` | `56a3b4ab76cde001b363c4a36adf3017700bbbae` | `LICENSE-pathling.txt` (Apache-2.0) |
| [brendankowitz/ignixa-fhir](https://github.com/brendankowitz/ignixa-fhir) | `test/Ignixa.FhirPath.Tests/` instance selector, analyzer, and coverage tests; `test/Ignixa.Validation.Tests/Checks/FhirPathInvariantCheckTests.cs` | `a9a8833143ab62b4eb5216e9d9f2d3cc97b03404` | `LICENSE-ignixa.md` (MIT) |
| [HL7/fhirpath.js](https://github.com/HL7/fhirpath.js) | `test/pathname.test.js`, `test/instance-selector.test.js` | `137c5014cb0fb7ba66c5762ff40bd5a3a000fd48` | `LICENSE-fhirpath.js.md` |

The cases were transcribed from each test's source by hand or by a parser, with
the expected results taken from upstream. Each case names its source file and,
where the upstream test has one, its test name. Shared inputs live under
`inputs`; a case that uses fhirpath.js's `patient-example.json` names the copy
in `fhirpathjs/resources/`.

Only cases this engine agrees with are listed, and only cases the suite does
not already have. Cases that disagree were reviewed and left out: engine
design differences, tests that the 3.0.0 text contradicts, and decisions
recorded in [Conformance](../../docs/conformance.md).

An expectation is one of:

- `values`: the exact result;
- `contains`: one object per result item, each giving only the elements the
  upstream test checks;
- `count`: the number of result items;
- `error`: the error class the evaluation throws (`FhirPathError` for any
  FHIRPath error);
- `analyzer`: whether `analyzeExpressionDetailed()` reports an error, and the
  result types it must include.
