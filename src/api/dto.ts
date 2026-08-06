import { mergeEnvKeys, normalizeEnvKeys } from '../engine/context.ts'
import { FhirPathTypeError } from '../errors.ts'
import type { R4TypeOf } from '../r4/generated/type-maps.ts'
import type { TypedValue } from '../values/typed-value.ts'
import { toSubjects } from './bundle.ts'
import type { AnyExpression, Compiler, CustomFunction, EvaluateOptions } from './compile.ts'
import type { ColumnOptions, ColumnResult, ProjectionColumn, ProjectionColumns } from './project.ts'

/** The object forms of ProjectionColumn — everything a column builder produces. */
type ColumnSpec = Exclude<ProjectionColumn, string>

/**
 * Ties `pick` to the table's row keys: with a table `map`, `pick` must name a
 * row field; without one, `pick` is rejected outright. Applied as a validation
 * intersection on the options parameter, so a `pick` typo is a compile error
 * at the call site.
 */
type PickConstraint<Options> = Options extends { map: readonly (infer Row extends { code: string })[] }
  ? { pick?: keyof Row & string }
  : { pick?: never }

/**
 * Declares the columns of one DTO (see `defineDto`), bound to its `fhirType` —
 * so paths stay relative to it and still infer their type:
 * `c('clinicalStatus.coding.first().code')` is `string | undefined` on a
 * Condition DTO. Takes the same options as a `project()` column: `type`,
 * `as`, `map`/`pick`, `enum`, `default`, `collection`.
 *
 * The static type of a builder call is the column's *value* (what a projected
 * row holds there) while its runtime value is the column spec; `defineDto`
 * keeps the specs and `project()` produces rows of values, which is what makes
 * the row type readable straight off the declaration.
 */
export interface ColumnBuilder<Root extends string> {
  <const Expr extends string>(path: Expr): ColumnResult<{ path: Expr }, Root>
  <const Expr extends string, const Options extends ColumnOptions>(
    path: Expr,
    options: Options & PickConstraint<Options>
  ): ColumnResult<{ path: Expr } & Options, Root>
  /**
   * A criteria column, with the same spec §4.5 semantics as
   * `FhirPathEngine.test()`: empty → false, a single boolean → itself. Always
   * a `boolean`, and projection-only — a criteria never registers as a function.
   */
  test<const Expr extends string>(criteria: Expr): boolean
}

/** What `defineDto` takes: the columns of one row shape, plus the data they read. */
export interface DtoDeclaration<Root extends string, Row> {
  /**
   * The resource or datatype the columns read, e.g. 'Observation' —
   * typo-checked against the model's type names, and the context every column
   * path infers against. `project()` checks each row's `resourceType` against
   * it and throws on a mismatch; a subject with no `resourceType` (a datatype
   * value) has nothing to check.
   */
  fhirType: Root
  /** Env data the DTO owns: lookup tables, system URLs. Registered engine-wide via EngineOptions.resourceDtos, and always applied when projecting the DTO. */
  env?: Record<string, unknown>
  /** Per-row bindings the columns read (EvaluateOptions.vars semantics; may reference per-call env). */
  vars?: Record<string, AnyExpression | readonly TypedValue[]>
  /** The columns, built through `c` so each one's value type comes from its expression. */
  columns: (c: ColumnBuilder<Root>) => Row
}

/**
 * What `defineDto` returns: the DTO's class — projectable and registrable as
 * it is, carrying its `fhirType` as a static, and instantiating to the row.
 * Subclass it to add getters and methods over the projected values —
 * `class ProblemRow extends ProblemDto { get label() { … } }`.
 */
export type DefinedDto<Root extends string, Row> = (new () => Row) & { readonly fhirType: Root }

/** A DTO class: what `defineDto` returns, or a subclass of one adding getters and methods. */
export type DtoClass = (new () => object) & { readonly fhirType: string }

/** The rows a DTO projection produces: the instance type itself, so getters and methods come along. */
export type DtoRow<C extends DtoClass> = InstanceType<C>

/** Everything a DTO class was defined with; `project()`, the engine, and `analyzeDto` all read it from here. */
export interface DtoDefinition {
  readonly fhirType: string
  readonly columns: ProjectionColumns
  readonly env: Record<string, unknown> | undefined
  readonly vars: Record<string, AnyExpression | readonly TypedValue[]> | undefined
}

/**
 * Definitions by the class `defineDto` created, kept outside the class so the
 * public class type stays `new () => Row` — nothing to declare, nothing for a
 * subclass to override by accident.
 */
const definitions = new WeakMap<object, DtoDefinition>()

/**
 * The definition a DTO class was created with, found by walking up from a
 * subclass (`class Row extends Schema.class {}` inherits it). A class that
 * never came from `defineDto` fails here rather than projecting to empty rows.
 */
export function dtoDefinition(cls: DtoClass): DtoDefinition {
  for (let current: unknown = cls; typeof current === 'function'; current = Object.getPrototypeOf(current)) {
    const definition = definitions.get(current as object)
    if (definition !== undefined) {
      return definition
    }
  }
  throw new FhirPathTypeError(`${cls.name || 'The class'} is not a DTO class; define it with defineDto()`)
}

/** The builder handed to `columns`: every call returns the spec it describes. */
function columnBuilder(): ColumnBuilder<string> {
  const build = (path: string, options?: ColumnOptions): ColumnSpec => ({ path, ...options })
  return Object.assign(build, {
    test: (criteria: string): ColumnSpec => ({ test: criteria }),
  }) as unknown as ColumnBuilder<string>
}

/**
 * A column value must be something `project()` can plan: a builder call, or a
 * bare path string. Anything else (a forgotten `c(…)`, a stray computed value)
 * would reach plan time as an unreadable column, so it fails at definition.
 */
function assertColumns(fhirType: string, columns: Record<string, unknown>): asserts columns is ProjectionColumns {
  for (const [name, spec] of Object.entries(columns)) {
    const isSpec =
      typeof spec === 'string' || (typeof spec === 'object' && spec !== null && ('path' in spec || 'test' in spec))
    if (!isSpec) {
      throw new FhirPathTypeError(
        `defineDto(${fhirType}): column '${name}' is not a column; build it with the c() argument`
      )
    }
  }
}

/**
 * Defines one row shape: the resource it reads, the columns it projects, and
 * the `vars`/`env` those columns need — so the declaration travels as one unit.
 * Column paths are relative to `fhirType` and keep their inferred types. The
 * returned class is the DTO: pass it to `project()` and
 * `EngineOptions.resourceDtos`, or subclass it to add getters and methods.
 *
 * ```ts
 * const WeightDto = defineDto({
 *   fhirType: 'Observation',
 *   columns: c => ({
 *     lbs: c("value.ofType(Quantity).toQuantity('[lb_av]').value", { default: 0 }),
 *     at: c('(effective.ofType(dateTime) | issued).first()', { as: 'Date' }),
 *   }),
 * })
 *
 * class WeightRow extends WeightDto {
 *   get rounded(): number {
 *     return Math.round(this.lbs)
 *   }
 * }
 * const rows = fp.project(observations, WeightRow) // WeightRow[]: lbs is number, at is Date | undefined
 * ```
 *
 * A column several DTOs share is a plain function of the builder —
 * `at: observedAt(c)` — and needs nothing from this API.
 */
export function defineDto<const Root extends keyof R4TypeOf & string, Row extends object>(
  declaration: DtoDeclaration<Root, Row>
): DefinedDto<Root, Row> {
  const { fhirType, env, vars } = declaration
  const columns = declaration.columns(columnBuilder() as unknown as ColumnBuilder<Root>) as Record<string, unknown>
  assertColumns(fhirType, columns)
  const dtoClass = class {}
  // A readable name: it identifies the DTO in project()/registration errors,
  // and a subclass replaces it with its own.
  Object.defineProperty(dtoClass, 'name', { value: `${fhirType}Dto` })
  Object.defineProperty(dtoClass, 'fhirType', { value: fhirType, enumerable: true })
  definitions.set(dtoClass, { fhirType, columns, env, vars })
  return dtoClass as unknown as DefinedDto<Root, Row>
}

/**
 * Fold registered DTO classes into the engine defaults: each column becomes an
 * expression-defined function (its analyzer signature derived from the column's
 * `type` when no `as`/`map` reshapes the value), and each DTO's `env` merges
 * in. Redefining an existing function or env variable is an error — silent
 * shadowing between DTOs would be impossible to debug from an expression.
 */
export function withDtos(defaults: EvaluateOptions, dtos: readonly DtoClass[], compile: Compiler): EvaluateOptions {
  if (dtos.length === 0) {
    return defaults
  }
  const functions: Record<string, CustomFunction> = { ...defaults.functions }
  const env: Record<string, unknown> = normalizeEnvKeys(defaults.env)
  const classPerType = new Map<string, string>()
  for (const dto of dtos) {
    const definition = dtoDefinition(dto)
    // One registered DTO per fhirType: it is the engine-wide vocabulary for
    // that resource, so a second one is a conflict, not an addition.
    const registered = classPerType.get(definition.fhirType)
    if (registered !== undefined) {
      throw new FhirPathTypeError(
        `DTO ${dto.name} registers fhirType '${definition.fhirType}', already registered by ${registered}`
      )
    }
    classPerType.set(definition.fhirType, dto.name)
    for (const [name, spec] of Object.entries(definition.columns)) {
      if (typeof spec === 'string' || 'test' in spec) {
        continue
      }
      if (name in functions) {
        throw new FhirPathTypeError(`DTO ${dto.name} redefines the function '${name}'`)
      }
      functions[name] = columnFunction(spec, compile)
    }
    for (const [name, value] of Object.entries(normalizeEnvKeys(definition.env))) {
      if (name in env) {
        throw new FhirPathTypeError(`DTO ${dto.name} redefines the environment variable %${name}`)
      }
      env[name] = value
    }
  }
  return { ...defaults, functions, env }
}

/**
 * A column's path as an expression-defined function; the analyzer signature
 * derives from `type` — or, for an `enum` column, plain String — as long as no
 * `as`/`map` reshapes the value outside FHIRPath.
 */
function columnFunction(spec: Extract<ProjectionColumn, { path: string }>, compile: Compiler): CustomFunction {
  const resultType =
    spec.as !== undefined || spec.map !== undefined
      ? undefined
      : (spec.type ?? (spec.enum !== undefined ? 'System.String' : undefined))
  return {
    expression: compile(spec.path),
    ...(resultType !== undefined && {
      signature: { result: { types: [resultType], single: spec.collection !== true } },
    }),
  }
}

/**
 * A projected DTO's `fhirType` checked against each row's actual resource:
 * a mismatch would not throw downstream — root-prefixed columns type-filter
 * to empty and the row comes back as well-typed defaults — so this is the
 * one place the mistake is visible. Fails loudly like the engine's other
 * runtime checks (the scalar-column rule, Bundle ambiguity, env overrides);
 * filter the input first to project a subset. A subject with no
 * `resourceType` (a datatype, e.g. a CodeableConcept) has nothing to check.
 */
export function assertInputMatchesDto(input: unknown, dto: DtoClass): void {
  const { fhirType } = dtoDefinition(dto)
  toSubjects(input).forEach((subject, index) => {
    const resourceType = (subject.value as { resourceType?: unknown } | null | undefined)?.resourceType
    if (typeof resourceType === 'string' && resourceType !== fhirType) {
      throw new FhirPathTypeError(
        `project(): row ${index} is a ${resourceType}, but ${dto.name} declares fhirType '${fhirType}'`
      )
    }
  })
}

/**
 * A projected DTO's own env and vars, merged under the per-call options (per
 * name, call wins) — so precedence runs engine defaults, then DTO, then call.
 * A DTO registered via EngineOptions.resourceDtos re-applies its env here with
 * identical values, which is harmless.
 */
export function dtoCallOptions(dto: DtoClass, options: EvaluateOptions | undefined): EvaluateOptions | undefined {
  const { env, vars } = dtoDefinition(dto)
  if (env === undefined && vars === undefined) {
    return options
  }
  const merged: EvaluateOptions = { ...options }
  if (env !== undefined) {
    merged.env = mergeEnvKeys(env, options?.env)
  }
  if (vars !== undefined) {
    merged.vars = mergeEnvKeys(vars, options?.vars)
  }
  return merged
}
