# Engine-bound DTOs and views

> Status: **implemented** on branch `feat/engine-bound-dtos`, on top of PR #83
> (DTO columns as `this.column()` field initializers). The Amendments section
> records where the implementation departs from the plan.

## What users gain

A column that calls a registered DTO column, such as `code.displayText()`, is
typed without a `type` option. Columns also see the engine's `env` and typed
host functions. `fhirpath-check` checks each DTO against the engine it belongs
to, rather than against the merged context of every engine it finds.

## API

Every DTO and view is defined on an engine. `register()` returns a new engine
with the DTOs' columns added as functions. It never changes the engine it is
called on, so the new engine's TypeScript type carries the new functions.

```ts
// patient-portal.dto.ts: every registered DTO and the engine they build
import { r4 } from 'fhirpath-ts/r4'

export class CodeableConceptDto extends r4.defineDto('CodeableConcept') {
  displayText = this.column('(text | coding.display.first() | coding.first().code).first()')
}
export class ConditionDto extends r4.defineDto('Condition') {
  clinicalStatusCode = this.column('clinicalStatus.coding.first().code')
}

export const fp = r4.register(CodeableConceptDto, ConditionDto)
```

```ts
// problems/problem-row.ts: a view, anywhere in the codebase
import { fp } from '../patient-portal.dto'

export class ProblemRow extends fp.defineView('Condition') {
  name = this.column('code.displayText()', { default: 'Condition' }) // string
  status = this.column('clinicalStatusCode()') // string | undefined

  get label(): string {
    return `${this.name} (${this.status ?? 'unknown'})`
  }
}

const rows = fp.project(conditions, ProblemRow)
```

- `engine.defineDto(fhirType, options?)` defines a DTO meant for registration.
  It holds only columns and methods: `register()` rejects getters and plain
  fields, because the engine's types treat every non-method field as a column.
  Its columns take no `as` or `choices`: a registered function returns the
  expression's own result, so a converted field type would misdescribe it.
  Conversions belong in views.
- `engine.defineView(fhirType, options?)` defines a projection-only row. Views
  keep getters, methods, and plain fields. `register()` rejects a view.
- `engine.register(...dtos)` returns a derived engine. It accepts DTOs defined
  on that engine or on an engine it derives from.
- Custom engines are built with `new FhirPathEngine(options)` and work the same
  way as `r4`. There is no `with()`: a derived engine that could redefine an env
  name or the model would break the types of DTOs defined on its parent.
- A DTO or view works on the engine it was defined on and on engines derived
  from it. `project()` on any other engine throws.
- The standalone `defineDto()` and the `resourceDtos` constructor option are
  removed. A constructor cannot take DTOs defined on the engine it builds.
- When a resource DTO calls another resource DTO's column, define it on the
  engine that already registers the callee:
  `const withConcepts = r4.register(CodeableConceptDto)`, then
  `class MedicationRequestDto extends withConcepts.defineDto(...)`.

### File layout (document in `docs/api.md`)

Keep every registered DTO in one `*.dto.ts` module. It builds them, registers
them, and exports the final engine. Views may live anywhere, and each imports
that engine and extends `engine.defineView(...)`. This keeps one engine value
per model version and gives `fhirpath-check` one module to import.

## Typing

- The column context is the defining engine's context (env, typed host
  functions, registered DTO functions), then the DTO's own `env` / `vars` /
  `callerEnv`, then `%rowIndex` / `%rowTotal`. This matches runtime precedence.
- A registered DTO column becomes a type-level function with input
  `[fhirType]`. Its result is the column's TypeScript type mapped back to the
  union of FHIR types with that TypeScript representation (a TS `string` becomes
  `string | code | uri | id | dateTime | …`). Mapping to one FHIR type would
  make `ofType(code)` infer empty where the runtime returns a value.
- `project(input, dto, options)` rejects a per-call `env` name the DTO's types
  took from the engine: a compile error, and a runtime check for JavaScript
  callers.

## Out of scope: a column calling a column of its own class

A field's type cannot depend on the type of its own class (TS7022). Such a
column declares `type`, which `analyzeDto` checks. Views may also reuse a
sibling value in TypeScript (a getter).

## Steps (green commits)

1. `defineDto` / `defineView` on the engine, typed by engine env and host
   functions; remove the standalone `defineDto`.
2. `register()` returning derived engines; view and getter rules;
   one engine lineage per DTO in `project()`.
3. Typed registered-DTO calls through the TS-to-FHIR union mapping. Measure
   the type-check cost and declaration size here; stop and review if either
   grows past the type-performance budget.
4. Per-call env guard; both walkers recognize `extends <engine>.defineDto/defineView(...)`;
   the CLI checks each DTO against its own engine; docs, dogfood, playground.

## Amendments

- **Registered functions live in the engine's options type.** `register()`
  returns `FhirPathEngine<RegisteredOptions<Defaults, Added>>`, which adds the
  columns to `functions`. A second `Dtos` type parameter cost about 10% on every
  ordinary engine call, because TypeScript measured its variance across all
  members.
- **Registered columns are expression functions to the type layer.** Each has
  `expression: string` and a `signature` with its input type and, when the field
  type maps to FHIR types, its result. Calls are typed exactly like host
  functions declared at construction.
- **`HostBodySource` returned `never` for a function with no body.** A host
  function without a body or result type made the whole expression `never`.
  It now returns `unknown[]`; `host-context.test.ts` covers it.
- **`analyzeDto()` defaults to the DTO's engine** and adds a registered DTO's own
  columns, so calls between columns of one class resolve.
- **Walkers.** The engine receiver of `defineDto`/`defineView` may be a relative
  import or a local; only another package's import rules it out. A local derived
  with `register()` is a trusted engine. Factories may be arrow functions or
  return class expressions. A class resolves through its own clause even when
  the file declares its name twice.
- **Type cost.** DTO-free engine calls stay within 2% of PR #83. The API fixture,
  which now covers engine context in columns, a registered DTO, and a typed call,
  measures +7.5% on TypeScript 5.9 and +26% on TypeScript 5.8. TypeScript 5.8
  re-instantiates the `RegisteredOptions` mapped type at every `this.column()`
  call of a view defined on a registered engine; 5.9 caches it. A plain object
  type for the same functions costs nothing extra on 5.8, so a future TypeScript
  feature that detaches a computed type from its generic source could remove it.
- **Column bodies read the engine env their types came from.** A registered
  column called with a per-call `env` value of an engine name returned that
  value while its type came from the engine's. `DtoDefinition.columnEnv` (the
  defining engine's env under the DTO's own) now overlays the caller's env on
  both routes, replacing the per-call env and vars refusal. Engine `vars` are
  left out of the column context, since they are evaluated against the
  caller's root.
