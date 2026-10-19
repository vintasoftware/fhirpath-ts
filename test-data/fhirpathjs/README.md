# fhirpath.js / fhirpath-py test corpus

Vendored reference-implementation test cases, converted from YAML to JSON offline
(PyYAML, groups flattened with `groupPath`/`inheritedDisable` markers).

| File | Source | Commit |
| --- | --- | --- |
| `cases.json` | [HL7/fhirpath.js](https://github.com/HL7/fhirpath.js) `test/cases/*.yaml` | `9b7c39d212bccfed945756e1c95a788807397b54` |
| `cases-py-extras.json` | [beda-software/fhirpath-py](https://github.com/beda-software/fhirpath-py) `tests/cases/` — only the two files that do not exist upstream (`3.2_paths.yaml`, `5.2.8_coalesce.yaml`) | `41de3574e6586d8a9ad13b5246325e89ed3f7ec8` |
| `resources/*.json` | fhirpath.js `test/resources/r4/` (the fixtures the r4/model-less cases reference) | same as `cases.json` |

`LICENSE.md` is the fhirpath.js license (NLM/Health Samurai, BSD-style) and covers
`cases.json` and the fixtures. `LICENSE-fhirpath-py.md` is the fhirpath-py MIT
license (beda.software) and covers `cases-py-extras.json`.

## How the harness runs them (`src/fhirpathjs.test.ts`)

- `fhir-r4.yaml` and `fhir-r5.yaml` are left out: those files copy the official
  suites, which `official.test.ts` runs directly with their modes and
  predicates. A hygiene test checks that every copied case is in the vendored
  official suites.
- Cases with `model: r5/stu3/dstu2` are skipped as a **different FHIR version**
  (this package ships the R4 model).
- Other cases disabled upstream run; the ones whose expected result is wrong
  are quirk families like any other divergence.
- Cases that need a feature the README defers (`%factory`, UCUM special units,
  typed element contexts) are skipped as **deferred features**, listed in
  `DEFERRED_FEATURES` in `quirk-manifest.ts` with the same key forms and
  hygiene checks as the quirks.
- Cases listed in `QUIRK_FAMILIES` are skipped as **intentional divergences**:
  each family documents the reference-implementation behavior we do not inherit
  and the spec/official-suite evidence for our reading. The hygiene tests fail if
  a manifest key shields no runnable case, if a shielded case starts passing, or
  if the manifest grows past a small fraction of the corpus. A key written as
  `file@model||expression` matches only cases run with that model (`none` for
  model-free cases); `file#desc||expression` matches one of several cases with
  the same expression.
- Everything else must pass.

Note that [octofhir/fhirpath-rs](https://github.com/octofhir/fhirpath-rs)
(`50b2aa46d`) was reviewed too: its corpus is a regrouped copy of the official
`fhir-test-cases` R5 suite (already run at 100% by `official.test.ts`) plus a few
custom cases ported into `src/reference-crosschecks.test.ts`.
