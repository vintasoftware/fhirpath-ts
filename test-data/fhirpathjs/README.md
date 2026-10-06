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

- Cases with `model: r5/stu3/dstu2` are skipped (this package ships the R4 model).
- Cases disabled upstream in `fhir-r4.yaml` and `fhir-r5.yaml` stay skipped:
  those files copy official-suite cases, which `official.test.ts` runs directly.
  Other cases disabled upstream run, except the ones listed in
  `DISABLED_UPSTREAM_SKIPS` with the reason their expected result is wrong.
- Cases listed in `quirk-manifest.ts` are skipped as **intentional divergences**:
  each family documents the reference-implementation behavior we do not inherit
  and the spec/official-suite evidence for our reading. The hygiene tests fail if
  a manifest key shields no runnable case, if a shielded case starts passing, or
  if the manifest grows past a small fraction of the corpus. A key written as
  `file@model||expression` matches only cases run with that model (`none` for
  model-free cases).
- Everything else must pass.

Note that [octofhir/fhirpath-rs](https://github.com/octofhir/fhirpath-rs)
(`50b2aa46d`) was reviewed too: its corpus is a regrouped copy of the official
`fhir-test-cases` R5 suite (already run at 100% by `official.test.ts`) plus a few
custom cases ported into `src/reference-crosschecks.test.ts`.
