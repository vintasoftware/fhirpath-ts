# Engine comparison

This comparison explains the design choices behind fhirpath-ts. It is based on
published package data, source review, and each project's documented test setup.
An em dash means the item was not assessed. “Not applicable” means the feature is
outside that tool's purpose.

## Implementation repositories

- **fhirpath-ts:** [vintasoftware/fhirpath-ts](https://github.com/vintasoftware/fhirpath-ts)
- **fhirpath.js:** [HL7/fhirpath.js](https://github.com/HL7/fhirpath.js)
- **fhirpath-py:** [beda-software/fhirpath-py](https://github.com/beda-software/fhirpath-py)
- **fhirpath-rs:** [octofhir/fhirpath-rs](https://github.com/octofhir/fhirpath-rs)
- **Medplum:** [medplum/medplum](https://github.com/medplum/medplum)
- **HAPI / HL7 Java:** engine in
  [hapifhir/org.hl7.fhir.core](https://github.com/hapifhir/org.hl7.fhir.core);
  HAPI adapters in [hapifhir/hapi-fhir](https://github.com/hapifhir/hapi-fhir)
- **helios-fhirpath:** [HeliosSoftware/hfs](https://github.com/HeliosSoftware/hfs)
- **kotlin-fhirpath:** [ohs-foundation/kotlin-fhirpath](https://github.com/ohs-foundation/kotlin-fhirpath)
- **HealthSamurai editor:** [HealthSamurai/fhirpath-editor](https://github.com/HealthSamurai/fhirpath-editor)

## Features

| | **fhirpath-ts** | fhirpath.js | fhirpath-py | fhirpath-rs | Medplum | HAPI / HL7 Java | helios-fhirpath | kotlin-fhirpath | HealthSamurai editor |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Runtime dependencies | none | ANTLR runtime, UCUM, and others | ANTLR runtime | Rust crates | none, as part of a large SDK | `org.hl7.fhir.core` | Rust crates | ANTLR runtime | Not applicable |
| Decimal arithmetic | exact by default | floating point; optional precise mode | Python decimal | Rust decimal | floating point | `BigDecimal` | documented loss of trailing zeros | precision 15; open work item | Not applicable |
| Official R4 and R5 suites in CI | all non-skipped cases | not run | not run | regrouped R5 | not run | R4 and R5 | R4 and R5 | R4 only | none |
| Tests from other engines | yes, with reasons for each difference | no | no | no | no | no | no | no | Not applicable |
| Compile-time result types | plain `tsc` | no | no | no | no | no | no | no | no |
| Default unknown-member result | `[]` | `[]` | `[]` | `[]` | `[]` | `[]` | `[]` | `[]` | `[]` through fhirpath.js |
| [Optional invalid-member check](https://hl7.org/fhirpath/N1/#type-safety-and-strict-evaluation) | CLI, ESLint, and API | no | no | analyzer API | no | `check()` API | strict runtime mode | strict runtime mode | editor inference |
| Terminology, async evaluation, `%factory` | deferred | yes | partial | `%factory` | no | yes | — | — | Not applicable |
| FHIR models | R4; provider interface | DSTU2 through R5 | DSTU2 through R5 | R5 | R4 | DSTU2 through R5 | R4 and R5 | R4, R4B, and R5 | — |

Every default evaluator listed above returns empty for an unknown member. That
runtime result does not make the member valid. fhirpath-ts, fhirpath-rs, HAPI,
and the HealthSamurai editor check members separately from evaluation. Helios
and kotlin-fhirpath instead offer an optional strict runtime mode.

This package focuses on application development in TypeScript:

- literal expressions infer result types without a plugin;
- common jobs have direct helpers such as `first`, `test`, `filter`,
  `checkConstraints`, and `project`;
- DTOs combine checked FHIRPath columns with normal TypeScript classes;
- the analyzer runs in ESLint, a standalone CLI, tests, and browser editors;
- the runtime package has no dependencies.

The main trade-offs are a synchronous engine, one bundled R4 model, and deferred
terminology and external-reference services. See
[Gaps and deferred features](../README.md#gaps-and-deferred-features).

## Correctness practices

| Practice | **fhirpath-ts** | fhirpath.js | fhirpath-py | fhirpath-rs | Medplum | HAPI / HL7 Java | helios-fhirpath | kotlin-fhirpath | HealthSamurai editor |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Static checker tested with official suites | valid and invalid cases | Not applicable | Not applicable | — | Not applicable | through phase checks | no | Not applicable | selected unit tests |
| Custom functions visible to static checking | one record for checking and evaluation | runtime table only | — | — | — | yes | no | no | Not applicable |
| `resolve()` typed from `targetProfile` | yes | Not applicable | Not applicable | — | Not applicable | yes | no | Not applicable | function absent |
| Property and differential testing | parser, values, and comparison with fhirpath.js | — | — | — | — | none | none | none | none |
| Upstream suite update check | weekly conversion and diff | — | — | — | — | no | tests current upstream source before releases | no | no |
| Reasons recorded for skips | checked manifests | — | — | — | — | — | reason list | registry and table | Not applicable |
| Regular expression backtracking | analyzer warning and replaceable engine | — | — | — | — | 500 ms timeout | none | none | Not applicable |

The conformance suite checks both error detection and false positives in the
static analyzer. A valid official case must not produce an analyzer error, and a
strict or semantic-invalid case must produce one.

Custom functions use one declaration for arity, analyzer signature, and runtime
behavior. This keeps application extensions visible to static checking.

## Test evidence

The package runs:

- all non-skipped official R4 and R5 cases;
- the fhirpath.js and fhirpath-py corpora;
- additional cases from fhirpath-rs and Medplum;
- generated parser round trips, arithmetic properties, temporal properties, and
  differential checks against fhirpath.js.

Every skipped case and intentional difference has a manifest entry. Tests fail
when an entry no longer matches its source case. Read
[Conformance](conformance.md) for counts and skip categories.

## Architecture choices

### Parser

The parser is a hand-written lexer and Pratt parser over a discriminated-union
AST with source spans. A printer returns an equivalent FHIRPath expression that
parses to the same tree.

This design avoids a parser runtime dependency and a generated-code build step.
It also gives direct control over error positions and parser depth limits. The
normative `fhirpath.g4` grammar remains the source used to check language
coverage. The Pratt parser structure is adapted from Medplum under Apache-2.0.

### Values

Decimals use a BigInt-scaled representation, so `0.1 + 0.2 = 0.3`. Dates, times,
and dateTimes retain their declared precision. The built-in UCUM table uses
exact decimal conversion factors for SI units and the units required by the
official suites.

Units outside the table can compare with themselves. Cross-unit conversion needs
a known exact factor. Offset, logarithmic, special, and arbitrary UCUM units are
not included in the current table.

### Models

The engine uses a `ModelProvider` interface that follows FHIRPath's ModelInfo
idea. The R4 provider and TypeScript maps are generated from the same HL7
StructureDefinitions. A different FHIR release or CDA can be added through
another provider without changing the evaluator.

## Scope of this comparison

The projects serve different audiences. HAPI is a full Java FHIR stack. Medplum
ships its evaluator as part of an SDK. HealthSamurai provides an editor rather
than a runtime. Rust and Kotlin implementations target different deployment
environments. The table compares FHIRPath behavior and development tooling, not
the value of each wider platform.
