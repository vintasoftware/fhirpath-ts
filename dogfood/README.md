# Application examples

This directory uses the engine in the same way as a healthcare application.

`patient-view.dto.ts` contains DTOs, shared base classes, variable joins, display
choices, and enum columns. It also creates the engine that uses them.
`patient-view-mappers.ts` contains application functions with
`@medplum/fhirtypes` inputs.

The `*.dto.ts` suffix lets `fhirpath-check` import the DTO module and check each
exported class with its engine. The tests:

- run every exported mapper on synthetic FHIR data;
- analyze expressions stored in constants, which source checks cannot connect to
  their later call site;
- run `fhirpath-check` on this directory and confirm that it finds the engine and
  all 13 exported DTOs.

No DTO list is maintained by hand. This directory is included in `pnpm
typecheck`, `pnpm test`, and the CI checks.

`sdc/` contains the Smart Forms integration example and SDC compatibility
probes. `smart-forms-fhirpath.ts` is the one adapter behind a build alias from
`fhirpath`: it takes fhirpath.js's call shape and translates argument order,
the fixed R4 model, `{ base, expression }` fragment types, typed results
carried between calls, and the `async`, `terminologyUrl`, and `fhirServerUrl`
options into the native API and the `fhirpath-ts/medplum` providers.
`template-path.ts` reads generated template JSON addresses, which are not
FHIRPath. `extract.ts` is an offline template-extraction prototype over pinned
LHC-Forms questionnaires, not a complete `$extract` implementation. The
[SDC readiness report](../docs/sdc-readiness.md) lists the Smart Forms changes
that remain.
