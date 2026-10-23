# SDC readiness and replacing fhirpath.js in Smart Forms

Assessed **2026-10-22**, against `origin/main` at
[`6c0fe5f`](https://github.com/vintasoftware/fhirpath-ts/commit/6c0fe5f08184834599802cfb16fa86fed9d890e5),
then re-run on the `fjsj/more-sdc` working tree, which carries the fixes below.
The primary reference is **fhirpath.js 5.2.1**, the latest npm release checked on
that date. A second run of the main assessment uses **4.11.0**, which satisfies
the pinned Smart Forms packages' `^4.10.1` dependency. fhirpath.js is a comparison
implementation, not the authority: where the two disagree, the FHIRPath and FHIR
specifications decide.

**This tree is a viable R4 expression engine for the tested SDC workflows.** It
supports local and service-backed scoring, terminology, remote resolution, and
native typed item contexts. The adapted Smart Forms comparison passes **322/323**
checks on main and on this tree; each reference version passes **320/323**. The
one failure is a date expectation that omits valid results, explained below.
These totals establish neither complete SDC conformance nor a performance
advantage.

The four implementation gaps the main assessment found are fixed on this tree:
**version-sensitive ValueSet scoring**, the **blood-pressure UCUM conversion**,
**bare-code scoring through element bindings**, and **R4 `ordinalValue` scores
over Medplum**. `%factory` and R5 stay out of scope. Replacing fhirpath.js still
requires the application adaptations and the service wiring described below; the
Smart Forms adapter in `dogfood/sdc/` holds all of the engine-side translation.

## What this tree supports

| SDC need | Support and verification |
| --- | --- |
| Extraction expressions and calculations | All 76 Smart Forms extraction-package tests pass after application adaptations. Renderer checks cover BMI, enablement, constraints, dynamic bindings, and preservation of `false` and `0`. PHQ-9 scores 9 with both engines; complete and partial Apgar cases pass. |
| Local `weight()` | Embedded answer/value weights, matching answer options, contained ValueSets, and contained CodeSystems work. Dedicated probes return 2 for a contained ValueSet and 3 for a contained CodeSystem without network access. |
| Versioned `weight()` | A ValueSet listing with the Coding's `version` wins in `compose.include` and `expansion.contains`; an unversioned or `*` listing stands in for any version; a Coding without a version takes only a weight the listings agree on. Both version probes now return 5; a conflict is an error. |
| Bare-code `weight()` | `Patient.gender.weight()` reads the CodeSystem of the element's required binding from the generated R4 model and scores it from a contained CodeSystem (probe returns 4) or the provider. |
| Service-backed scoring | `evaluateAsync()` can expand a remote answer ValueSet and read a remote CodeSystem `itemWeight` property. Probes return 8 and 3. The Medplum provider also reads R4 `ordinalValue` concept extensions from the CodeSystem resource when `$lookup` reports no weight. |
| Terminology expressions | `memberOf()`, `subsumes()`, `subsumedBy()`, and the six `%terminologies` operations use host callbacks. `fhirpath-ts/medplum` supplies them over a Medplum client, or over plain `fetch` for a terminology server. |
| Reference resolution | Local resources, Bundle entries, and contained references resolve synchronously. Async evaluation adds a remote resolver and passes the owning server base to it. Contained-reference probes make no HTTP calls. |
| UCUM conversion | `(1 'mm[Hg]').toQuantity('kPa')` is `0.133322 'kPa'`, exact from UCUM's definition of the meter of mercury column (133.3220 kPa). `N`, `Pa`, `m[Hg]`, their prefixes, `/min`, and `{annotation}` units reduce; every unit code the Smart Forms and LHC-Forms questionnaires use is covered. |
| Typed extraction contexts | `evaluateTyped()` results can be passed directly into the next evaluation. They preserve FHIR types, ancestry, `$this`, `%context`, `%resource`, and `%rootResource`. `r4.toTyped(value, type, { in: resource })` attaches an existing object fragment by identity. |
| Questionnaire item scope | `sdcScope(r4, questionnaire)` supplies `%questionnaire`, `%qitem`, and separate contexts for repeated response items, including nested `answer.item` contexts. |
| Extension-only primitives | Plain results omit missing primitive values: `birthDate` returns `[]`. The logical element still exists, and `evaluateTyped()` retains its metadata. A probe reads its weight successfully. |

The focused language checks also pass all **33 cases**: `Age` survives
`as(Quantity)` and `ofType(Quantity)`, ascending/descending sorting works,
date/string extrema work, unknown escapes discard the backslash, and object
equality distinguishes different `id` values.

## Comparison results

| Check | This tree | Main at 6c0fe5f | fhirpath.js 5.2.1 | fhirpath.js 4.11.0 |
| --- | --- | --- | --- | --- |
| Entire extraction package | 76 passed | 76 passed | 76 passed | 76 passed |
| Entire population package, original expected responses | 208 passed, 1 failed | 208 passed, 1 failed | 209 passed | 209 passed |
| Separate full population response with spec-correct dates | 1 passed | 1 passed | 1 failed | 1 failed |
| Renderer variables and calculation/behavior checks | 28 passed | 28 passed | 26 passed, 2 failed | 26 passed, 2 failed |
| Terminology, resolution, and scoring integration probes | 9 passed | 9 passed | 9 passed | 9 passed |
| **Total, no skips** | **322 passed, 1 failed** | **322 passed, 1 failed** | **320 passed, 3 failed** | **320 passed, 3 failed** |
| Capability probes (version, UCUM, bare code, canonical version, contained version) | 6/6 | 3/6 | 0/6 | not run |

The population disagreement concerns full timestamps such as
`2015-02-12T12:00:00+00:00`. `onset.ofType(dateTime).toDate()` returns
`2015-02-12` here; both references return empty. The original health-check
response omits four onset/abatement dates. A separate full-response assertion
checks those dates against the source Conditions and passes here. The
references' two renderer failures exercise the same conversion. The original
upstream expected response remains unchanged. DateTime-to-Date conversion is
defined by the [FHIRPath specification](https://hl7.org/fhirpath/STU3/#todate--date),
so this difference is retained.

Whole-operation comparisons give **15/17 exactly equal extraction outputs**. The
two other outputs differ only in generated `MedicationStatement.dateAsserted`
precision: this engine includes `.000` for the same instant. **4/5 population
outputs match exactly**; the fifth contains the four dates above. The comparison
includes Bundle fields and returned issues, uses deterministic UUIDs and a fixed
clock, and excludes only the application's debug attachment. The suites include
repeated items, empty answers, `false` and `0` values, and the PATCH comparison
scenarios of the extraction package.

The suite executes 717 engine calls across 21 extraction tests, 219 across 13
population tests, 199 in the separate population oracle, 29 across 20 renderer
tests, and nine service calls. The counts are application-test results, not
language-conformance percentages.

Repository checks on this tree: `pnpm typecheck`, `pnpm test` (**8,149 passed,
281 skipped**, 76 files), `pnpm lint`, `pnpm check:fhirpath`, `pnpm check:inference`,
`pnpm check:type-perf` (API surface +1.0%, within budget; no baseline change),
`pnpm coverage` (99.4% statements), `pnpm build`, and `pnpm check:package` all pass.
The `%factory` probe still fails by design, and the custom-profile `conformsTo()`
probe records unsupported behavior on both engines.

## Fixes on this tree

### Version-sensitive ValueSet scoring

`weight()` collects every listing of the Coding's system and code in the value
set, with the code system version each selects: `expansion.contains.version`,
or `compose.include.version` for its concepts. A listing with the Coding's
version is the concept it names and wins. A listing without a version, or with
the `*` wildcard that
[`ValueSet.compose.include.version`](https://hl7.org/fhir/R4/valueset-definitions.html#ValueSet.compose.include.version)
defines, selects every version and stands in when no listing names the Coding's.
A listing with another version is another concept and is ignored. A Coding
without a version may be any listing, so their weights must agree; a conflict
such as `v1` scoring 2 and `v2` scoring 5 throws rather than choosing one. A
version the value set does not list leaves the lookup to the CodeSystem, as
before. Expansion listings keep precedence over compose listings for the version
they list. ValueSet canonical versions (`url|version`) and contained CodeSystem
version selection are unchanged and still pass their probes; fhirpath.js fails
both.

### UCUM

The unit table gains UCUM's derived definitions for `N` (`kg.m/s2`), `Pa`
(`N/m2`), and `m[Hg]` (133.3220 kPa), each prefixable, reduced through the
existing exact-Decimal canonicalizer; a `{annotation}` is unity; a missing
numerator before `/` is one. The questionnaire inventory (Smart Forms
`apps/`, `packages/`, `resources/`, and the LHC-Forms fixtures) uses `kg`,
`cm`, `mm[Hg]`, `kg/m2`, `%`, `mmol/L`, `/min`, `wk`, `a`, `mg`, `Cel`, `m`,
`d`, `h`, `min`, `mL/h`, `mg/dL`, `g/cm-2`, `dB`, and the annotations
`{tablet}` and `{score}`; all reduce or, for the decibel, compare as a special
unit. Two fixtures write `beats/min` and `breaths/min`, which are not UCUM
codes and stay opaque on both engines. The full `@lhncbc/ucum-lhc` dependency
was not adopted: it adds about a megabyte and float arithmetic for a handful of
units the corpus needs, and the table is extended in one place when a new
unit appears.

### Bare-code scoring

The generator records, for every `code` element whose required binding
resolves to exactly one code system, the index of that system in a new
generated list (`src/r4/generated/code-systems-data.ts`, 202 systems, about
11 KB with the element markers). The R4 model exposes it as
`boundCodeSystem(type, element)`, and `weight()` uses the element a typed
`code` was read from. The lookup then follows the Coding path: contained
CodeSystems first, then the provider. The remaining limitation: 344 of 354 R4
`code` bindings resolve; the others draw from several code systems
(`Task.intent`, `Timing.repeat.when`, `DetectedIssue.status`, the `all-types`
and `defined-types` bindings) or from value sets the R4 definitions do not
carry, and a code outside any element (a computed string) has no binding.
Those still raise `weight() cannot resolve the CodeSystem binding ... of a code`,
never an empty result. Binding versions are not recorded; a bound code is
looked up without a version.

### Medplum

`fhirpath-ts/medplum` exports `medplumTerminology(client)` and
`medplumResolver(client)` over the `fhirUrl()`, `get()`, and `post()` methods
of `MedplumClient`, and `fhirClient(baseUrl, headers)` as the same shape over
plain `fetch`. Medplum supports the six operations the tested questionnaires
and probes need (`ValueSet/$expand`, `ValueSet/$validate-code`,
`CodeSystem/$lookup`, `CodeSystem/$validate-code`, `CodeSystem/$subsumes`,
`ConceptMap/$translate`); the recorded cassette in
`test-data/terminology/medplum.json` holds answers from a live server for all
six, and `pnpm record:tx:medplum` now records through this provider. The
`$lookup` answer carries `itemWeight` only for concepts loaded with
`CodeSystem/$import` properties; for an R4 CodeSystem whose concepts carry
`ordinalValue` extensions, the provider reads the resource by `url` and
`version` and reports the extension as the property. A concept found without
one is a confirmed absence (empty); a code system or concept the server does
not have is unavailable (an error). The extension fallback and the error
mapping are verified with a stand-in client in `src/terminology/medplum-provider.test.ts`
and `dogfood/sdc/smart-forms-fhirpath.test.ts`; **they were not run against a
Medplum deployment**, since this environment has no Medplum credentials.

## Application integration still required

An argument-order/model-only substitution passes **4/20** of a selected
extraction control; the adapter plus the Smart Forms edits below pass **20/20**
and the full suites above. Native context support removes the need to rewrite
expressions, but it does not make the two JavaScript APIs interchangeable.

### The adapter

`dogfood/sdc/smart-forms-fhirpath.ts` exports `smartFormsFhirpath(services)`,
whose `evaluate(fhirData, path, envVars, model, options)` is the fhirpath.js
shape Smart Forms calls. In one place it:

- fixes the R4 model and ignores the `fhirpath/fhir-context/r4` argument;
- types a `{ base, expression }` fragment with `r4.toTyped(fragment, base)`;
- returns typed values for `resolveInternalTypes: false`, recognizes them by
  identity when they come back as the input or inside `envVars`, and passes
  them through `vars` so they keep their types and resource scope;
- keeps the `async` contract: `false` is synchronous and a service need throws;
  `true` evaluates synchronously and returns a Promise only when the engine
  raises `FhirPathAsyncRequiredError` or the expression calls `resolve()` with a
  FHIR server configured; `'always'` returns a Promise. The renderer caches
  Promise results by expression, so a local `weight()` must stay synchronous;
- maps `terminologyUrl` and `fhirServerUrl` to providers through the `services`
  function: `fetchServices` over plain fetch, or `medplumServices(client)`, which
  uses one authenticated client and ignores the URLs.

A build alias (`resolve.alias: { fhirpath: '<adapter>', 'fhirpath/fhir-context/r4': '<any module>' }`)
redirects every call site; the assessment runner wires it this way for the
extraction, population, renderer, and services suites. An application-level
engine switch is the alias target. Errors are `Error` instances, which Smart
Forms already stringifies.

### Smart Forms changes that remain

These are the exact edits the assessment applies to the pinned extraction
package; the first three are correctness fixes that benefit either engine:

1. **Read generated template JSON addresses with a JSON reader.** `_family` is
   primitive metadata in FHIR JSON; logical navigation uses `family.extension`.
   `templateExtractPath.ts`, `parseFhirPath.ts`, and `staticTemplateData.ts`
   import `readTemplatePath` (`dogfood/sdc/template-path.ts`) in place of
   `fhirPathEvaluate` for template addresses. Authored FHIRPath expressions are
   left alone; guessing which string is which would be ambiguous.
2. **Keep authored primitive filters.** `expressionManipulation.ts` no longer
   rewrites `ofType(string)` into `ofType(String)`: FHIR primitive filters are
   correct FHIRPath, and the System rewrite selects nothing in a model-aware
   engine.
3. **Bind PATCH comparison expressions to the comparison response.**
   `extract.ts` passes `{ ...fhirPathContext, resource: comparisonSourceResponse, rootResource: comparisonSourceResponse }`
   when populating from the comparison response. An environment `%resource`
   overrides the typed context's own resource in both engines, so without this
   the comparison pass reads the current response.
4. **Retain typed contexts.** `fhirpathEvaluate.ts` takes a `typed` flag that
   passes `resolveInternalTypes: false`; `evaluateTemplateExtractPath.ts` and
   `buildBundle.ts` set it for context and response-item evaluations whose
   results feed value expressions. Primitive contexts, duplicate values, and
   choice types survive; copies made in between would not.
5. **One authored expression.** The `QRepeatingComplexValueMerge` fixture's
   `.answer.valueCoding` becomes `.answer.value.ofType(FHIR.Coding)`: a JSON
   choice key is not a FHIR model path.

Launch contexts, named-variable scope, dependency scheduling, x-fhir-query
execution, template assembly, PATCH, OperationOutcome handling, and persistence
stay with the SDC host, as they do with fhirpath.js. The adapter does not add
permissive navigation, regex expression rewriting, a fallback to fhirpath.js,
or ancestry guessed from matching values.

## Scope and adoption decision

Smart Forms source is pinned to
[`6fe2eab`](https://github.com/aehrc/smart-forms/tree/6fe2eab7c0f2fd5eb3281b834556a6f227329a23):
extraction 1.0.16, population 4.7.2, renderer 1.5.0. LHC-Forms fixtures are pinned to
[`433f800`](https://github.com/LHNCBC/lforms/tree/433f80008bfe5f3d03b08269a6dc83f5a5f3c226).
Both applications use fhirpath.js; this is two SDC integrations against one
independent reference engine. The [LHC-Forms manifest](../test-data/sdc/lforms/manifest.json) records the
fixtures' source paths and checksums.

`%factory` remains unavailable and R5 is out of scope. Profile-aware
`conformsTo()`, `slice()`, `elementDefinition()`, and `checkModifiers()` remain
deferred; fhirpath.js also reports `conformsTo` unimplemented. Use a profile
validator for extracted resources. The XHTML `hasValue()` question
[#126](https://github.com/vintasoftware/fhirpath-ts/issues/126) remains open and
is not a demonstrated SDC extraction failure.

There was no browser/React interaction run, full LHC-Forms application run,
live terminology-server run, live Medplum run, client-questionnaire run, output
profile validation, or latency measurement. The 281 repository skips are also a
coverage limit.

For the tested R4 workflows, adopting this tree is reasonable with the five
Smart Forms edits and the alias above. Before committing a migration, run the
client's forms through the adapter against both engines, check them for
factories and non-R4 features, validate extracted Bundles against the client's
profiles, record the Medplum provider against the client's project, and measure
editing/extraction latency.

## Reproduce

The offline probes run with the repository tests:

```sh
pnpm exec vitest run dogfood/sdc
```

The Smart Forms comparison, the capability probes, and their recorded outputs
stay outside the repository. The comparison runner downloads the pinned Smart
Forms source, installs its runtime dependencies, applies the edits listed
above, and runs every suite with fhirpath.js 5.2.1 and with the adapter. It
exits **1** for the retained date expectation and the generated-timestamp
differences.
