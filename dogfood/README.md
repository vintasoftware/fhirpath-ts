# Real-usage tests

Modules in this directory come from real apps and use the engine the way an
app does. `patient-view.dto.ts` holds the row shapes and the engine that projects
them — DTO definitions, shared base classes, `vars` joins, display choices, and
`enum` columns; `patient-view-mappers.ts` holds the functions an app calls, with
`@medplum/fhirtypes` inputs. The split follows the `*.dto.ts` convention
`fhirpath-check` discovers, so `pnpm check:fhirpath` imports this directory's
DTOs and checks them against their engine. Each module has a test beside it that:

- asserts every exported function end to end, on synthetic FHIR data;
- runs `analyzeExpression` over the expressions no checker can discover — the
  ones held in a `const`, which every source walker sees as a variable;
- runs the real `fhirpath-check` over this directory, so DTO discovery itself is
  under test: it imports `patient-view.dto.ts`, finds the engine it constructs,
  and analyzes all 13 exported DTOs against it.

Nothing lists the DTOs. Discovery covers them, which is the point of the
`*.dto.ts` convention.

The directory is part of `pnpm typecheck` and `pnpm test`, which CI runs on
every push. When an engine change breaks how a real app uses it, it breaks
here first.
