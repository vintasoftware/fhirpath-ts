# `project()` types its input structurally, not by generated shape

A DTO knows its root as a literal (`ConditionDto.fhirType` is `'Condition'`),
and the package generates a full TypeScript interface for every R4 type. We
nevertheless type the input of `project()` and `Dto.from()` as
`{ resourceType: 'Condition' }` (plus the array and Bundle forms), not as the
generated `Condition` interface. One property check per call catches a wrong
resource, a non-resource, and a non-object, which is what issue #88 asked for.
Comparing two large interfaces on every call would cost compiler time and would
couple a client's own FHIR types (for example `@medplum/fhirtypes`) to the
generated ones, where a single optionality or primitive-extension difference
breaks every call site. Datatype roots accept any object.

## Considered options

- The generated interface as input type: stronger (rejects a misspelled
  property in a fixture), but the costs above. Revisit if a client asks for it
  as an opt-in.
- Keep `unknown`: the previous behaviour; rejected because it lost a check the
  hand-written constructors had.
