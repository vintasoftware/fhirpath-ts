# SDC readiness: Smart Forms on Medplum with fhirpath-ts

Validated **2026-10-23** at
[`5c7e6fd`](https://github.com/vintasoftware/fhirpath-ts/commit/5c7e6fd) (PR #143,
not yet merged), for an R4 deployment that renders and scores questionnaires with
Smart Forms and keeps its data and terminology in Medplum. R5 features and
`%factory` are out of scope.

| Component | Version |
| --- | --- |
| Medplum server | 5.2.7 (`5.2.7-7e139c3`, Medplum cloud), a non-production project with synthetic data |
| Medplum SDK | `@medplum/core` 5.2.7 |
| Smart Forms | renderer 1.5.0, `sdc-populate` 4.7.2, `sdc-template-extract` 1.0.16 (source [`6fe2eab`](https://github.com/aehrc/smart-forms/tree/6fe2eab7c0f2fd5eb3281b834556a6f227329a23), the published versions) |
| fhirpath.js (comparison) | 4.11.0, the version those packages' `^4.10.1` range installs |
| Browser | Chrome (headless), driven through the real renderer UI |

There is no client application yet, so the browser runs used a test application
built for this validation: Vite and React with `SmartFormsRenderer` and
`sdc-populate`, one server per engine, and the same timing wrapper around both
engines. Medplum traffic goes through a local proxy that adds the token, so no
credential reaches the browser, and that can delay or fail matching requests.
The forms were a synthetic intake form written to exercise the client's
workflows and Smart Forms' own story questionnaires, including the large MBS 715
health check. No client questionnaires, response examples, profiles, or
extraction templates exist yet; Smart Forms' and
[sdc-extractor-ts](https://github.com/vintasoftware/sdc-extractor-ts)'s test
fixtures stand in for them.

**Recommendation: ready for a client pilot, with the limitations listed under
[Adoption](#adoption).** Every workflow below gives the expected result, and
every difference from fhirpath.js 4.11.0 is either an fhirpath.js defect or a
documented, valid difference. Five defects found in this round are fixed in
this PR. The remaining limits are in Smart Forms'
error handling, in Medplum's terminology and validation behavior, and in what
could not be tested without client material.

## Evidence

Coverage: **live** runs against the Medplum project; **browser** runs drive the
Smart Forms UI against the same project; **fault** runs use the live server
behind injected delays or failures; **suite** runs the Smart Forms package tests
offline with each engine; **mocked** runs use a stand-in client;
**untested** has no evidence.

| Workflow | Expected | Actual | Coverage |
| --- | --- | --- | --- |
| `ValueSet/$expand`, `memberOf()`, `CodeSystem/$lookup`, `$validate-code`, `ConceptMap/$translate` | Server answers; an unknown value set is indeterminate | As expected | live |
| `subsumes()` / `subsumedBy()` with Coding versions | True/false from the server; a version the server lacks is indeterminate; two different versions fail | As expected | live |
| Remote `weight()` from imported `itemWeight` properties | 2.5 | 2.5 | live, browser |
| R4 `ordinalValue` concept extensions (CodeSystem resource) | The concept's ordinal | 1 and 5 for `v1` and `v5` | live, browser |
| Version selection | Explicit version wins; an unknown version is an error; an unversioned Coding with disagreeing versions is an error | As expected | live |
| Version reported by `$lookup` | Selects the resource | Medplum's `$lookup` reports no version | mocked only |
| Search pagination | 24 versions, page size 20; the deciding version, and a conflict, only on page two | Found; conflict reported | live |
| A later search page fails | Error, nothing cached; same provider recovers | As expected | fault |
| Concept without a weight vs unavailable terminology | `[]` vs error; a 503 fails `weight()` | As expected | live, fault |
| Relative, absolute, and `_history` references on the server | Resolved | Resolved | live |
| Missing reference, another server | Empty; another server gets no request | As expected, 0 requests | live |
| Contained and Bundle-local references, local scoring | Resolved locally | 0 requests | live |
| `async: true` resolves through the client without `fhirServerUrl` | Resolved | Resolved; ignores a form's URLs | live, browser |
| Launch-context population, x-fhir-query variables, `initialExpression` with `resolve()` | Identical responses on both engines | Identical (intake; MBS 715: 79 values, 0 differences) | browser |
| Calculated scores, severity, `enableWhenExpression` across answer changes | Follow the answers | Identical on both engines through every change | browser |
| `false` and `0` answers | Kept and compared | As expected | browser, suite |
| Dependent choices (`answerOptionsToggleExpression`) | Options of the other category disabled | Identical on both engines | browser |
| Constraints, BMI, repeated groups, nested `answer.item`, Quantity, dates, primitives, extension-only values | Smart Forms' expected outputs | Population 208/209 plus the spec oracle; renderer 28/28; extraction 76/76 | suite |
| Template extraction: ids, references, PATCH comparison, issues | Same Bundles as fhirpath.js | 15/17 identical; 2 differ in `dateAsserted` precision only | suite |
| sdc-extractor-ts (472 tests) | Pass | 472/472 on this commit | suite |
| Extracted and populated resources against base R4 | Same issues on both engines | Identical issue sets; every error is in a test fixture | live `$validate` |
| Client profiles | Validate | No client profiles exist | untested |
| Rapid edits while terminology is slow (1.5 s) | Final answers decide the score | Correct on both engines | browser, fault |
| Terminology outage, then recovery | No silently lower score; correct score afterwards | Engine fails the score; Smart Forms keeps the previous score (see below); fhirpath-ts recovers, fhirpath.js does not | browser, fault |
| Entering a repetition of a repeating group in the UI | Counted | The test driver's text did not reach the response with either engine | untested in browser |

The population difference is the four Condition dates Smart Forms' expected
response omits: `onset.ofType(dateTime).toDate()` returns the date here and
empty in fhirpath.js, and the two renderer failures of fhirpath.js exercise the
same conversion, which the
[FHIRPath specification](https://hl7.org/fhirpath/STU3/#todate--date) defines.
The extraction difference is `now()` with `.000` milliseconds; both forms are
valid FHIR `dateTime` values.

Repository checks at this commit: `pnpm typecheck`, `pnpm test` (8,147 passed,
281 skipped), `pnpm lint`, `pnpm check:fhirpath`, `pnpm check:inference`,
`pnpm check:type-perf` (within budget, no baseline change), `pnpm coverage`,
`pnpm build`, and `pnpm check:package` pass. The Medplum recording
(`pnpm record:tx:medplum`) passes all 15 cases live and leaves nothing behind.

## Defects fixed in this round

Each has a regression test.

| Defect | Class | Reproducer | Commit |
| --- | --- | --- | --- |
| Medplum's `$subsumes` rejects `codingA`/`codingB` (400 `invalid`), which the provider read as "no answer", so Coding subsumption returned empty | Medplum provider | `%a.subsumes(%b)` on two v3-ActCode Codings returned `[]` | `b92c911` |
| A CodeSystem loaded with `CodeSystem/$import` is a `complete` resource without concepts, so `weight()` failed for concepts the server has | Engine rule, applied to a server resource | `weight()` of an imported concept without `itemWeight` threw instead of scoring empty | `b92c911` |
| Medplum's `$lookup` and `$validate-code` take the version only from the `version` parameter, so a Coding's version was ignored | Medplum provider | `weight()` of a Coding with a version Medplum lacks returned `[]`, a lower score | `2fde810` |
| `ordinal()`, the SDC name before `weight()`, was an unknown function | Engine | sdc-extractor-ts's `ordinal()` tests on the built-in `weight()` | `b7d3a0a` |
| The adapter sent `$expand` and `$lookup` again for every remote-scored answer on every recalculation | Adapter | Rapid edits with 1.5 s latency took 29.5 s to settle (fhirpath.js: 0.6 s) | `5c7e6fd` |

## Other findings

**Smart Forms behavior** (same on both engines):

- The renderer does not put the Questionnaire in the FHIRPath context, so
  `weight()` of an answer fails ("needs `%questionnaire`") in both engines. The
  host passes it as `additionalVariables={{ questionnaire }}` on
  `SmartFormsRenderer`, created once: a new object on each render rebuilds the
  form in a loop.
- An evaluation error is a `console.warn` and the item keeps its previous value.
  During a terminology outage the score shows the last good total, not an
  error. The engine fails the expression rather than dropping the remote weight,
  but the user sees a stale score.
- MBS 715 item-level expressions read `%patient`, which the renderer does not
  pass there; both engines warn eight times.
- Results of expressions without `%` that returned a Promise are cached by text
  for the session.

**Medplum behavior and configuration:**

- `$subsumes` takes `system`, `version`, `codeA`, and `codeB` only.
- `$lookup` reports no `version`; ValueSet `$validate-code` ignores a Coding's
  version.
- `[Type]/$validate` returns "All OK" for a `meta.profile` whose
  StructureDefinition is not loaded in the project; a loaded profile (US Core
  Patient) is enforced. Check that every profile is present before relying on a
  clean result.
- Search pages hold 20 entries and have no default order.
- `MedplumClient` caches GETs for 60 s in a browser and not at all in Node.

**fhirpath.js 4.11.0**, for the comparison: besides the date conversion above,
its terminology fetch cache keeps failed responses, so a score stays wrong
after the server recovers.

**Test fixtures:** the Medplum validation errors are in the fixtures, identically
for both engines: nested Bundles without `entry.request` (`bdl-3`), an
Immunization without `occurrence[x]`, Conditions without `subject`,
AllergyIntolerances without `clinicalStatus` (`ait-1`), a Patient extension with
both a value and extensions (`ext-1`), and `system`/`code` written directly on a
CodeableConcept.

**sdc-extractor-ts** keeps its own `weight()` host function. The built-in now
covers its contained-option cases; the remaining differences are design choices
of the extractor: it reads every contained ValueSet of the Questionnaire rather
than the item's `answerValueSet`, fails on two weights for one code anywhere in
the Questionnaire, and scores a bare `Coding.code`.

## Measurements

Browser, live Medplum, the same proxy and timing wrapper for both engines.
Engine time is synchronous evaluation inside the wrapper; network time is the
sum of proxied request durations. Warm loads: 11 (intake) and 7 (MBS 715) after
one cold load. Answer changes: 11 after the first, on the remote-scored
question.

| Measure (p50 / p95) | fhirpath-ts | fhirpath.js 4.11.0 |
| --- | --- | --- |
| Intake, warm load wall time | 1255 / 1491 ms | 1252 / 1547 ms |
| Intake, warm load engine time (36 calls) | 2.5 / 3.0 ms | 13.3 / 16.0 ms |
| Intake, population engine time | 1.2 / 1.3 ms | 5.7 / 7.3 ms |
| Intake, requests per load | 5, no duplicates | 5, no duplicates |
| Intake, first remote-scored answer | 578 ms, 3 requests | 297 ms, 1 request |
| Intake, later answer changes, wall | 176 / 299 ms | 167 / 216 ms |
| Intake, later answer changes, engine (19 calls) | 0.9 / 1.3 ms | 3.0 / 4.6 ms |
| MBS 715, warm load wall time | 1302 / 1434 ms | 1278 / 1399 ms |
| MBS 715, warm load engine time (750 calls) | 32.6 / 44.7 ms | 55.2 / 58.3 ms |
| MBS 715, requests per load | 14, no duplicates | 14, no duplicates |

Wall time is set by the network and the renderer: the engines differ by
milliseconds of engine time inside loads of more than a second. A first
remote-scored answer costs fhirpath-ts two more requests, because it asks
`$expand` and `$lookup` before reading the CodeSystem resource, which fhirpath.js
reads directly; the adapter then answers repeats from its cache.

Offline Smart Forms suites, one run, per-test duration (p50 / p95):
extraction (76 tests) 0.5 / 7.8 ms against 0.4 / 18.2 ms; population (209 tests)
0.2 / 1.7 ms against 0.2 / 2.2 ms. These include test overhead and show engine
cost only.

## Integration

`dogfood/sdc/smart-forms-fhirpath.ts` is the one compatibility module. A build
alias points `fhirpath` at it; `smartFormsFhirpath(medplumServices(client))`
answers terminology and `resolve()` through one authenticated `MedplumClient`
and ignores URLs a form names. It fixes the R4 model, types
`{ base, expression }` fragments, keeps typed results by identity, keeps
fhirpath.js's `async` contract, and answers each terminology request once per
services instance, sending a failed request again.

The application also needs:

1. `additionalVariables={{ questionnaire }}` on the renderer, created once
   (above).
2. For template extraction with `sdc-template-extract`, the five edits the
   offline suite applies; the first three fix behavior for either engine:
   read generated template addresses with a JSON reader
   (`dogfood/sdc/template-path.ts`); keep authored `ofType(string)` filters;
   bind PATCH comparison expressions to the comparison response; pass
   `resolveInternalTypes: false` where context results feed value
   expressions; and, in one fixture, `.answer.value.ofType(FHIR.Coding)` for
   the JSON key `.answer.valueCoding`. sdc-extractor-ts needs none of them.

The browser runs needed nothing else: no expression rewrites, no fallback to
fhirpath.js, and no change to the renderer or `sdc-populate`.

## Adoption

Ready for a client pilot with these limitations, each with the work that
closes it:

- **Stale scores during terminology failures.** Smart Forms keeps the previous
  value and only warns. Before a pilot depends on remote scores, surface
  calculation errors in the host (or a Smart Forms change), or keep scoring
  weights local to the Questionnaire, which needs no network.
- **Client material.** Run the client's questionnaires, synthetic responses,
  and extraction templates through both engines when they exist, with the
  harness described below.
- **Profiles.** Load the client's StructureDefinitions into the Medplum
  project and confirm each `meta.profile` is present before trusting
  `$validate`; `conformsTo()` is not a substitute.
- **Repeating groups in the UI.** Confirm entering repetitions in the browser;
  the offline suites cover their evaluation.
- **Latency.** Repeat the measurements from the production region and network.

## Reproduce

The harnesses and their outputs are local to the assessment and not part of the
repository or package:

- the live provider and adapter harness (41 cases), which creates tagged
  synthetic resources under a run-specific `example.org` URL and deletes them;
- the Medplum `$validate` runner for extracted and populated resources;
- the browser test application, its fixture setup and teardown, and the
  interaction, fault, and timing drivers;
- the offline Smart Forms comparison, which downloads the pinned source and runs
  every suite with fhirpath.js and with the adapter.

`pnpm exec vitest run dogfood/sdc src/terminology` runs the adapter and provider
regression tests, and `pnpm record:tx:medplum` re-records the Medplum cassette
against a project given by `MEDPLUM_BASE_URL`, `MEDPLUM_CLIENT_ID`, and
`MEDPLUM_CLIENT_SECRET`.
