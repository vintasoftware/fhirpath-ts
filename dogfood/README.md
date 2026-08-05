# Real-usage tests

Modules in this directory come from real apps and use the engine the way an
app does. The mappers here use DTO classes, declared columns, `vars` joins,
display tables, and `enum` columns, with `@medplum/fhirtypes` inputs. Each
module has a test beside it that:

- asserts every exported function end to end, on synthetic FHIR data;
- runs `analyzeDto` over every DTO class and `analyzeExpression` over every
  standalone expression, so a typo inside an expression string fails CI.

The directory is part of `pnpm typecheck` and `pnpm test`, which CI runs on
every push. When an engine change breaks how a real app uses it, it breaks
here first.
