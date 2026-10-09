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
