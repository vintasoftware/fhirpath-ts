# DTO typing, inference, and client simplification (October 2026)

Status: implemented on `fjsj/improve-dtos-types-for-bb` as one commit per
pull request below (2026-10-06); the Effect on PR 559 section is the
migration guide. Tracks
[issue #88](https://github.com/vintasoftware/fhirpath-ts/issues/88) and the
friction found by
[building-blocks PR 559](https://github.com/vintasoftware/building-blocks/pull/559),
which rewrites fourteen hand-written DTO classes as fhirpath-ts DTOs.

Vocabulary follows [CONTEXT.md](../../CONTEXT.md). Decisions with a trade-off
are recorded in [docs/adr](../adr).

## What PR 559 ran into

| Friction in PR 559 | Cause in fhirpath-ts 0.3 | Fix (PR below) |
| --- | --- | --- |
| `fp.project(42, ConditionDto)` compiles; `{}` projects into defaults | `DtoClass` widens `fhirType` to `string`; input typed `unknown`; runtime check skips inputs without `resourceType` | 1 |
| `id` and `start` need `default: ''` to drop `undefined` | No way to say "must be present" | 1 |
| Every mapper imports `fp` to call `fp.project(x, Dto)` | The class has no projection entry point | 1 |
| `status` cast with `as status => status as Task['status']` | Model data drops required bindings; `code` infers `string` | 2 |
| `quantity` and `address` cast to medplum types | Generated interfaces mark every element optional; medplum requires `Extension.url` | 2 |
| `group` needs `enum: [...]` + `default` | Type-level parser discards string literal text | 3 |
| `instructions`, `addressText`, `displayName` need `type: 'string'` | 64-token inference limit (`addressText` is exactly 64 tokens) | 3 |
| `resourceDto()` factory with `ViewBaseClass` annotation and `type:` on `id`/`lastUpdated` | No way to share columns across roots; inference cannot run on a generic root | 4 |
| `fhirpath-check` crash on `as const satisfies` | Any tuple-typed binding in a file passed on the command line: the walker calls `getBaseTypes()` on a tuple reference, which has no symbol | 5 |
| +65 KB gzipped on the patient app bundle | Engine plus R4 model in the browser | out of scope, see below |

## Decisions

1. **Input type is structural.** `project()` and `Dto.from()` require
   `{ resourceType: Root }`, `readonly { resourceType: Root }[]`, or a
   `BundleLike`. Datatype roots accept `object`. See
   [ADR 0001](../adr/0001-structural-input-type-for-project.md). An untyped value
   needs a narrowing step first; the documented mixed-Bundle recipe becomes
   `r4.evaluate('Bundle.entry.resource.ofType(Patient)', bundle)`, which already
   infers `Patient[]`.
2. **Runtime rejects a non-resource for a resource root.** A subject that is not
   an object, or has no `resourceType`, or has a different one, throws
   `FhirPathTypeError`. Datatype roots are unchanged.
3. **`required: true` is an input precondition.** It is allowed only on a
   column whose expression is a path of singular element names (`id`, `start`,
   `meta.lastUpdated`); anything else is a compile error, and `default` covers
   that case. The DTO's accepted input gains that path as a required property
   (`{ resourceType: 'Appointment'; start: string }`, nested for dotted paths),
   and the field type drops `undefined` because the input proves presence.
   `DtoInput<typeof Dto>` exposes the derived input type. There is no runtime
   check: a Bundle entry, a cast, or a registered-function call that reaches a
   missing value reads `undefined` or empty, as any column does. `required`
   excludes `default` and `collection`. Base columns contribute their
   requirements to every subclass, so a DTO with `ResourceDto` as base demands
   `id` on its input, as the old `WithId<Resource>` constructors did.
4. **`Dto.from(input, options?)`.** A static on the class `defineDto` /
   `defineView` return, typed like the engine's `project` overloads, projecting
   on the defining engine. `engine.project` stays for derived engines.
5. **Code unions from required bindings.** The generator emits each `code`
   element's required-binding literals, and inference returns the union
   (`'draft' | 'requested' | ... | undefined`), as `@medplum/fhirtypes` does.
   Runtime data is unchanged; this is type-only. Conditional on the type-perf
   budget.
6. **Generated interfaces keep min=1 elements required; inputs stay lenient.**
   See [ADR 0003](../adr/0003-generated-interfaces-keep-required-elements.md).
   The interfaces surface as results (column types, `evaluate` results) and as
   the input of root-prefixed expressions through `FhirpathInput`. Only the
   results become stricter: `FhirpathInput` turns into
   `{ resourceType: Root } & DeepPartial<Resource>`, so
   `r4.evaluate('Observation.status', { resourceType: 'Observation' })` keeps
   compiling and a misspelled property stays an excess-property error.
   Measured in the type-perf budget.
7. **String literal unions in inference.** `iif(c, 'a', 'b')` and
   `'a' | 'b'` infer the literal union. Literals only; no string operations.
8. **Raised inference limits.** `INFERENCE_TOKEN_LIMIT` and the source step
   limit rise as far as the budget allows, measured, with the new numbers
   explained in the budget change.
9. **Base DTOs.** `defineDto('Condition', { base: ResourceDto })`, where the
   base is a DTO on a model supertype of the root. A DTO takes a DTO base; a
   view takes a DTO or a view. See
   [ADR 0002](../adr/0002-base-is-a-dto-kind-follows-subclass.md). Rules:
   - any model supertype qualifies, including the same type (plain composition);
   - base `env`, `vars`, and `callerEnv` are inherited; a subclass cannot rebind
     a name the base binds (settled 2026-10-06 in review: the original
     "subclass wins" clause gave inherited columns a type from the base's
     binding and a value from the subclass's); a redeclared column overrides,
     as today;
   - the runtime input check becomes subtype-aware: a `Resource` DTO accepts any
     resource, a `DomainResource` DTO any domain resource; the input type is the
     union of matching resource names;
   - registering a base and a subclass on one engine makes an inherited column
     two overlapping declarations and throws the existing overlap error;
   - without a model only a same-root base is allowed.
10. **Release.** Decision 1, 2, and 6 are breaking; the first PR to land ships
    as 0.4.0 under the RELEASING.md rule.

## Pull requests

Independent, one per layer. Each runs the AGENTS.md required checks plus
`npm run generate:dts` in `demo/` when the public API changes.

### PR 1: DTO layer (closes #88)

- `src/api/dto.ts`: `DtoClass<Root extends string = string>` keeps the literal;
  `DtoInput<C>` = `{ resourceType: Root }` (or `object` for a datatype root)
  intersected with the required paths of the class's columns, derived at the
  type level from each `required` column's path (singular element names only,
  checked against `R4Elements` cardinality; a non-path or plural expression is a
  compile error); `required` in `ColumnOptions`/`DtoColumnOptions` and in
  `ColumnResult` (`src/api/project.ts`); `KindConstraint` excludes
  `required` + `default` / `collection`; `assertInputMatchesDto` rejects
  non-objects and missing `resourceType` for resource roots; `from` static on
  `DtoBaseClass` and `createDtoBase`. `required` has no runtime behaviour.
- `src/api/engine.ts`: `project` DTO overloads typed from `DtoInput<C>`; the
  Bundle overload stays untyped at the entry level for a class without required
  columns; a class with one refuses a Bundle (`BundleInput`), so every input
  that reaches a required column is typed (closed in a follow-up PR).
- Tests: `src/api/dto.test.ts` (fixtures listed in the typing-surface audit
  need `resourceType`; add `@ts-expect-error` cases for 42, `{nonsense}`, wrong
  resource, a `required` column missing from the input, `required` on an
  expression column; `expectTypeOf` for `from` and `DtoInput`).
- Docs: `docs/api.md` DTO section (input type, `from`, `required` as a
  precondition, new Bundle recipe), README recipes, AGENTS.md (structural input
  rule; `required` is type-only, so projection/function parity is untouched).
- Perf: `src/typed/verification/api-perf-fixture.types.ts` gains a `from` call;
  budget change explained if any.

### PR 2: model generator and code unions

- `scripts/generate-r4-model.ts`: keep min=1 required in interfaces; emit the
  required-binding literals per `code` element into `R4Elements` (type-only, so
  `resources-data.ts` and the browser bundle do not grow).
- `src/typed/parser.ts` `PublicResult`: read the literal member when the element
  carries one; `R4TypeOf['code']` stays `string`.
- `src/typed/infer.ts` `FhirpathInput`: `{ resourceType: Root } & DeepPartial<R4Resources[Root]>`
  so root-prefixed `evaluate`/`compile`/`first` inputs stay partial; keep the
  README and api.md fixtures compiling without edits; measure `apiSurface`.
- Checks: `check:r4-model` drift, `check:inference` ratchet, `check:type-perf`
  (type-maps.ts growth is the risk; measure before and after), `check:fhirpath`.
- Docs: `docs/api.md` "every generated field optional" paragraph.

### PR 3: typed parser

- `src/typed/parser.ts`: carry a literal payload for string literals through
  `LiteralState`, `UnionState`, and `iif`; nothing else consumes it.
- `src/typed/inference-limits.ts`: raise limits; measured in
  `scripts/type-perf-budget.json` with the explanation in the same change.
- Corpus: add PR 559's long expressions (`addressText`, `displayName`,
  `instructions`) to `src/typed` precision fixtures so the limit is covered.

### PR 4: base DTOs

- `src/api/dto.ts`: `DtoOptions.base`; `dtoDefinition` merges base columns,
  env, vars, callerEnv; kind rule at the type level and in `baseDefinition`;
  subtype-aware `assertInputMatchesDto` through the model's base map;
  `SubtypesOf<Root>` for the input type of an ancestor root.
- `src/analyzer/analyze-dto.ts`: a column inherited unchanged is analyzed on
  the root it was written for, so a base column that dispatches on the resource
  type does not become an always-empty warning on every subclass.
- Walkers: `dtoClassesOf` still matches (`extends engine.defineDto(...)`); add a
  `base:` corpus entry to `src/analyzer/expression-policy.test.ts`.
- Docs: `docs/api.md` (replaces the `keyedRow` factory recipe; `ViewBaseClass`
  stays for factories), AGENTS.md "Engine-bound DTOs" rules.

### PR 5: `fhirpath-check`

- `src/sites/index.ts:465`: `isEngineExpression` calls `checker.getBaseTypes()`
  on any type with the `Reference` object flag. A non-empty tuple type
  (`[a, b] as const`, `readonly [string, string]`) is a reference without a
  symbol, and TypeScript throws `Cannot read properties of undefined (reading
  'flags')`. Guard on `Class | Interface` flags of the type or its reference
  target before calling `getBaseTypes`; a tuple is never an engine. Reproduced
  on 0.3.0 and on `main` with PR 559's `observation.dto.ts` when files are
  passed on the command line; PR 559's `check:fhirpath` script passes none, so
  only the syntax scanner runs there. The regression test needs a program with
  a checker, so it lives in `src/sites/sites.test.ts`; the walker corpus runs
  without one and cannot reach this code.
- `src/cli/dto-check.ts:55-57`: resolve glob matches with `path.resolve(cwd, match)`
  so an absolute `--dtos` pattern imports.

## Out of scope: browser bundle

PR 559 measured +65 KB gzipped. Reproduced at 65.8 KB with esbuild against the
built package: R4 model data 27.6 KB (42%), engine core 29.8 KB (45%, lexer,
parser, evaluator, the 20 built-in function modules, UCUM/date/decimal values),
analyzer 8.5 KB (13%, kept by the `strict` runtime option through
`src/api/strict.ts`), DTO code 0.1 KB. The engine core does not shrink with
usage. Levers, if ever wanted: a per-type model subset (about 22 KB saved for
PR 559's twelve roots without following Reference targets, 13 KB with them),
and downstream code-splitting of `fhirpath-ts/r4`, which saves nothing but moves
the model off the initial load. Not part of this plan: it is independent of the
typing work and the analyzer lever conflicts with `strict` working without a
manual import.

## Effect on PR 559

What each file loses once the fhirpath-ts changes land.

- `resource.dto.ts`: the factory, `ViewBaseClass`, `DtoOptions`, and
  `FhirTypeName` imports go. It becomes
  `class ResourceDto extends fp.defineDto('Resource')` with
  `id = this.column('id', { required: true })` and
  `lastUpdated = this.column('meta.lastUpdated')`.
- Every resource DTO: `extends fp.defineDto('X', { base: ResourceDto, ... })`.
  `ObservationDto` and `TaskDto` keep `as` for epoch / `Date` conversions, so
  they use `fp.defineView('X', { base: ResourceDto })`.
- `appointment.dto.ts`: `ScheduledAppointmentDto.start` becomes
  `{ required: true }`, so `ScheduledAppointmentDto.from(x)` demands
  `start: string` at compile time. The hand-written `ScheduledAppointment` type
  can become `DtoInput<typeof ScheduledAppointmentDto>` or go away.
- `medication-request.dto.ts`, `diagnostic-report.dto.ts`, `task.dto.ts`:
  `status` loses its `as` cast and infers the union; `required: true` makes the
  input demand it, or keep `default: 'unknown'`. `group` loses `enum` and keeps
  `default` to drop `undefined` (an `iif` column cannot be `required`).
- Every `from()` call demands `id` on its input through the `ResourceDto`
  base, which `WithId<...>` already provides at every call site in PR 559.
- `observation.dto.ts`, `organization.dto.ts`: `quantity` and `address` lose
  their `as` casts.
- `organization.dto.ts`, `patient.dto.ts`, `medication-request.dto.ts`:
  `type: 'string'` goes once the raised limits cover the expressions (verify
  against the branch source; the relayed `instructions` already inferred).
- Fourteen mappers and the tests: `fp.project(x, Dto)` becomes `Dto.from(x)`;
  the `fp` import goes. Wrong inputs are compile errors again.
- `datatypes.dto.ts`: unchanged; `fp` stays exported for registration.
