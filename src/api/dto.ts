import '../functions/install.ts'

import { bareEnvironmentName, mergeEnvKeys, normalizeEnvKeys } from '../engine/context.ts'
import { FhirPathTypeError } from '../errors.ts'
import { functions as builtinFunctions } from '../functions/registry.ts'
import type { ModelProvider } from '../model/provider.ts'
import type { R4Bases, R4Elements, R4Resources, R4TypeOf } from '../r4/generated/type-maps.ts'
import type { BareContextName } from '../typed/context-maps.ts'
import type {
  EmptyFhirpathTypeContext,
  FhirpathTypeContextOf,
  FhirpathTypeDeclarations,
  InputOf,
  MergeFhirpathTypeContexts,
} from '../typed/infer.ts'
import { canonicalFocusType, typesOverlap } from '../values/type-compat.ts'
import type { TypedValue } from '../values/typed-value.ts'
import { type BundleLike, toSubjects } from './bundle.ts'
import { columnSignature, criteriaSignature } from './column-signature.ts'
import {
  type AnyExpression,
  COLUMN_FUNCTIONS,
  type ColumnCustomFunction,
  type Compiler,
  type CustomFunction,
  type EvaluateOptions,
  type SingleCustomFunction,
} from './compile.ts'
import type { FhirPathEngine } from './engine.ts'
import type { ColumnOptions, ColumnResult, ProjectionColumn } from './project.ts'

/** The object forms of ProjectionColumn: what `this.column()` and `this.criteria()` record. */
export type ColumnSpec = Exclude<ProjectionColumn, string>

/**
 * The options of a required column: a column whose path the input must carry
 * (see `DtoInput`). Nothing may empty or replace the value, so the fallback,
 * the conversions, and a declared `type` are excluded; the path is a singular
 * model element, so inference is exact. `required` is type-only: the runtime
 * never sees it.
 */
export interface RequiredColumnOptions {
  required: true
  type?: never
  collection?: never
  default?: never
  as?: never
  choices?: never
  pick?: never
  enum?: never
}

declare const requiredPath: unique symbol

/**
 * Marks the value of a required column with the path the input must carry.
 * The marker is an optional symbol property, so the value still reads and
 * assigns as its plain type; `DtoInput` reads the path back from the class.
 */
export interface RequiredColumn<Path extends string> {
  readonly [requiredPath]?: Path
}

/**
 * Ties `pick` to the table's row keys: with a table `choices`, `pick` must name
 * a row field; without one, `pick` is rejected outright. Applied as a validation
 * intersection on the options parameter, so a `pick` typo is a compile error at
 * the column.
 */
type PickConstraint<Options> = Options extends { choices: readonly (infer Row extends { code: string })[] }
  ? { pick?: keyof Row & string }
  : { pick?: never }

/**
 * What a DTO class is for. A `'dto'` is registered on an engine, so its columns
 * become FHIRPath functions; a `'view'` is only projected.
 */
export type DtoKind = 'dto' | 'view'

/**
 * The column options of a registered DTO. A registered column is also a
 * function that returns its expression's own result, so options that convert
 * the projected value (`as`, `choices`) belong in a view.
 */
export type DtoColumnOptions =
  | {
      collection?: boolean
      type?: keyof R4TypeOf
      default?: unknown
      enum?: readonly string[]
      required?: never
    }
  | RequiredColumnOptions

/** The column options of a view: every projection option, or a required column. */
export type ViewColumnOptions = ColumnOptions | RequiredColumnOptions

/** Data a DTO reads in addition to the projected resource. */
export interface DtoOptions {
  /**
   * Values owned by the DTO, with keys written with or without `%`. They apply
   * only to this DTO's column bodies, projected or called as functions.
   */
  env?: Readonly<Record<string, unknown>>
  /** Per-row bindings the columns read (EvaluateOptions.vars semantics; may reference per-call env). */
  vars?: Readonly<Record<string, AnyExpression | readonly TypedValue[]>>
  /**
   * Environment supplied by `project()`. Use names when only presence is known,
   * or declarations when columns and vars navigate through those values.
   */
  callerEnv?: readonly string[] | FhirpathTypeDeclarations
}

/**
 * `DtoOptions` plus a base: a DTO whose columns, `env`, `vars`, and `callerEnv`
 * this class inherits. Its root is this root or one of its model base types
 * (`Resource`, `DomainResource`, or the same type), and it was defined on this
 * engine or one this engine derives from. A DTO takes a DTO as base; a view
 * takes a DTO or a view. The class's own options win on a name clash, and a
 * redeclared column overrides. `base` lives outside `DtoOptions` so a function
 * forwarding `DtoOptions` to `defineView()` keeps a statically known base class.
 */
export interface DtoBaseOptions extends DtoOptions {
  readonly base: DtoClass
}

/** What `createDtoBase` receives: either option set. */
export type DtoDefinitionOptions = DtoOptions & { readonly base?: DtoClass }

/** Keys the type-only facts of a DTO class: nothing is defined under it at runtime, and no name reaches autocomplete. */
declare const dtoTypes: unique symbol

/**
 * The base class's own context (its env, vars, caller environment, and row
 * variables), read from the type-only static the engine's base carries. The
 * engine context is not part of it: the subclass merges its own engine's once,
 * and that engine is the base's or derives from it.
 */
type BaseContext<Options> = Options extends {
  readonly base: { readonly [dtoTypes]: { readonly context: infer Context extends object } }
}
  ? Context
  : EmptyFhirpathTypeContext

/** The kind of a base class, or `never` without one. */
type BaseKind<Options> = Options extends {
  readonly base: { readonly [dtoTypes]: { readonly kind: infer Kind extends DtoKind } }
}
  ? Kind
  : never

/** The bare names a class's own options bind: env, vars, and the caller environment. */
type OwnBoundNames<Options> = BareContextName<
  keyof OptionField<Options, 'env'> | keyof OptionField<Options, 'vars'> | CallerEnvNamesOf<Options>
>

type CallerEnvNamesOf<Options> =
  OptionField<Options, 'callerEnv'> extends infer Declared
    ? Declared extends readonly (infer Name extends string)[]
      ? Name
      : keyof Declared
    : never

/** The names a base's context binds: its env with the caller declarations, and its vars; the row variables are everyone's. */
type BaseBoundNames<Options> =
  BaseContext<Options> extends { env: infer Env; vars: infer Vars }
    ? Exclude<keyof Env, 'rowIndex' | 'rowTotal'> | keyof Vars
    : never

/**
 * A subclass cannot rebind a name its base binds: the inherited columns were
 * typed against the base's binding, and the runtime would read the subclass's.
 */
type RebindConstraint<Options> = [OwnBoundNames<Options> & BaseBoundNames<Options>] extends [never]
  ? unknown
  : { readonly rebinds: `the base already binds ${Extract<OwnBoundNames<Options> & BaseBoundNames<Options>, string>}` }

/** The columns, methods, and getters a base class adds to the class extending it. */
export type BaseFields<Base extends DtoClass> = Omit<InstanceType<Base>, 'fhirType'>

/** Whether `Type` is `Base` or derives from it in the model. */
type DerivesFrom<Type extends string, Base extends string> = Type extends Base
  ? true
  : Type extends keyof R4Bases
    ? R4Bases[Type] extends infer Parent extends string
      ? DerivesFrom<Parent, Base>
      : false
    : false

/**
 * The `base` option as the kind and the root allow. A DTO takes a DTO as base,
 * a view a DTO or a view; the base root is the root or one of its model base
 * types. Applied as a validation intersection on the options parameter.
 */
export type BaseConstraint<Kind extends DtoKind, Root extends string, Options> = Options extends {
  readonly base: infer Base
}
  ? Base extends DtoClass<infer BaseRoot>
    ? Kind extends 'dto'
      ? BaseKind<Options> extends 'dto'
        ? BaseRootConstraint<Root, BaseRoot> & RebindConstraint<Options>
        : { base: 'a DTO takes a DTO as base; a view takes a DTO or a view' }
      : BaseRootConstraint<Root, BaseRoot> & RebindConstraint<Options>
    : { base: 'a base is a class from defineDto() or defineView()' }
  : unknown

type BaseRootConstraint<Root extends string, BaseRoot extends string> =
  DerivesFrom<Root, BaseRoot> extends true
    ? unknown
    : { base: 'the base root must be this root or one of its model base types, such as Resource' }

/**
 * One option as the columns see it. A record without literal keys, such as the
 * `DtoOptions` shape itself, declares nothing: its names are unknown either way.
 */
type OptionField<Options, Name extends keyof DtoOptions> = Options extends { readonly [K in Name]?: infer Value }
  ? string extends keyof Exclude<Value, undefined>
    ? EmptyFhirpathTypeContext
    : Exclude<Value, undefined>
  : EmptyFhirpathTypeContext

type CallerEnvTypes<Options> =
  OptionField<Options, 'callerEnv'> extends infer Declared
    ? Declared extends readonly string[]
      ? EmptyFhirpathTypeContext
      : Declared
    : never

/**
 * What a DTO's columns see: its own `env` and `vars`, the declared caller
 * environment, and the row variables `project()` binds. Runtime precedence is
 * the same: DTO values win over caller values, and row variables win over both.
 */
export type DtoContext<Options> = Options extends { readonly base: unknown }
  ? MergeFhirpathTypeContexts<BaseContext<Options>, OwnDtoContext<Options>>
  : OwnDtoContext<Options>

/** A class's own context with the row variables, which a base's `dtoContext` static already carries. */
type OwnDtoContext<Options> = MergeFhirpathTypeContexts<
  OwnContext<Options>,
  { env: { rowIndex: { type: 'System.Integer' }; rowTotal: { type: 'System.Integer' } } }
>

/** The context a class's own options declare; merged under a base's when there is one. */
type OwnContext<Options> = FhirpathTypeContextOf<{
  env: OptionField<Options, 'env'>
  envTypes: CallerEnvTypes<Options>
  vars: OptionField<Options, 'vars'>
}>

/**
 * The markers made so far for each class being collected. Keyed by class, so a
 * field initializer may collect another DTO meanwhile.
 */
const collecting = new Map<object, ColumnMarker[]>()

/** What `this.column()` returns while its class is collected; any other time it returns undefined. */
class ColumnMarker {
  readonly spec: ColumnSpec

  constructor(spec: ColumnSpec) {
    this.spec = spec
  }
}

/** The options a column of this kind accepts. */
type ColumnOptionsOf<Kind extends DtoKind> = Kind extends 'dto' ? DtoColumnOptions : ViewColumnOptions

/** The `pick` check applies to view columns, the only ones with `choices`. */
type KindConstraint<Kind extends DtoKind, Options> = Kind extends 'dto' ? unknown : PickConstraint<Options>

/**
 * `required` is allowed only where the input type can name what it demands: a
 * path of singular element names from the root. Any other expression is
 * rejected at the option, and `default` covers it instead.
 */
type RequiredConstraint<Root extends string, Expr extends string, Options> = Options extends { required: true }
  ? [RequiredPathInput<Root, Expr>] extends [never]
    ? {
        readonly requiredPath: 'a required column reads a path of singular element names, such as id or meta.lastUpdated'
      }
    : unknown
  : unknown

/** A required column's field type: the inferred value without `undefined`, marked with its path. */
type RequiredColumnResult<Expr extends string, Root extends string, Context extends object> = Exclude<
  ColumnResult<{ path: Expr }, Root, Context>,
  undefined
> &
  RequiredColumn<Expr>

/** The element information of `Element` on `Type`, walking the model's base types. */
type ModelElement<Type extends string, Element extends string> = Type extends keyof R4Elements
  ? Element extends keyof R4Elements[Type]
    ? R4Elements[Type][Element]
    : InheritedElement<Type, Element>
  : InheritedElement<Type, Element>

type InheritedElement<Type extends string, Element extends string> = Type extends keyof R4Bases
  ? R4Bases[Type] extends infer Base extends string
    ? ModelElement<Base, Element>
    : never
  : never

type UnionToIntersection<Union> = (Union extends unknown ? (member: Union) => void : never) extends (
  member: infer Intersection
) => void
  ? Intersection
  : never

type IsUnion<Type> = [Type] extends [UnionToIntersection<Type>] ? false : true

/** The one type of a singular, non-choice element, or `never`. */
type SingularElementType<Type extends string, Element extends string> = [Type] extends [never]
  ? never
  : ModelElement<Type, Element> extends { t: infer Named extends string; a: false }
    ? IsUnion<Named> extends true
      ? never
      : Named
    : never

/**
 * The input shape a required path demands: nested objects down to the
 * element's TypeScript type. `never` when a segment is not a singular,
 * non-choice element of the type before it.
 */
type RequiredPathInput<Type extends string, Path extends string> = string extends Path
  ? never
  : Path extends `${infer Head}.${infer Rest}`
    ? RequiredPathInput<SingularElementType<Type, Head>, Rest> extends infer Nested
      ? [Nested] extends [never]
        ? never
        : { readonly [Key in Head]: Nested }
      : never
    : SingularElementType<Type, Path> extends infer Leaf
      ? [Leaf] extends [never]
        ? never
        : Leaf extends keyof R4TypeOf
          ? { readonly [Key in Path]: InputOf<Leaf> }
          : never
      : never

/**
 * The instance side of every DTO and view. `engine.defineDto()` and
 * `engine.defineView()` return a subclass bound to one engine, FHIR type, and
 * option set; declare columns as fields of a class extending it.
 */
export class DtoBase<
  Root extends string = string,
  Context extends object = EmptyFhirpathTypeContext,
  Kind extends DtoKind = DtoKind,
> {
  /** Type-only: keeps a view out of `register()`. Protected, so rows never show it. */
  declare protected readonly dtoKind: Kind

  /** The FHIR type the columns read. It lives on the prototype, so it is not one of a row's own keys. */
  get fhirType(): Root {
    return (this.constructor as unknown as { readonly fhirType: Root }).fhirType
  }

  /**
   * Declares one column: the expression it reads, relative to the class's
   * `fhirType`, plus the same options a `project()` column takes. Write it as a
   * field initializer; the field's type is inferred from the expression and the
   * DTO's `env`, `vars`, and `callerEnv`.
   */
  protected column<const Expr extends string>(path: Expr): ColumnResult<{ path: Expr }, Root, Context>
  protected column<const Expr extends string, const Options extends ColumnOptionsOf<Kind>>(
    path: Expr,
    options: Options & KindConstraint<Kind, Options> & RequiredConstraint<Root, Expr, Options>
  ): Options extends { required: true }
    ? RequiredColumnResult<Expr, Root, Context>
    : ColumnResult<{ path: Expr } & Options, Root, Context>
  protected column(path: string, options: ColumnOptions | RequiredColumnOptions = {}): unknown {
    // `required` is a claim about the input type; the recorded column is a plain one.
    const { required: _required, ...spec } = options as ColumnOptions & { required?: true }
    return mark(this, { path, ...spec })
  }

  /**
   * Declares a Boolean criteria column. It uses `FhirPathEngine.test()` rules: one
   * Boolean returns itself, empty returns `false`, and several values are an
   * error. A registered criteria function keeps the same behavior.
   */
  protected criteria(expr: string): boolean {
    return mark(this, { test: expr }) as unknown as boolean
  }
}

/**
 * Records a column while its class is collected. A field initializer runs just
 * before the field is defined, so when the next column is declared the previous
 * marker must already sit in a field. Otherwise it went into a private field, a
 * nested value, or nowhere.
 */
function mark(instance: DtoBase, spec: ColumnSpec): ColumnMarker | undefined {
  const found = collecting.get(instance.constructor)
  if (found === undefined) {
    return undefined
  }
  assertLastMarkerStored(instance, found)
  const marker = new ColumnMarker(spec)
  found.push(marker)
  return marker
}

function assertLastMarkerStored(instance: object, found: readonly ColumnMarker[]): void {
  const last = found.at(-1)
  if (last !== undefined && !Object.values(instance).includes(last)) {
    const expression = 'test' in last.spec ? last.spec.test : last.spec.path
    throw new FhirPathTypeError(
      `DTO ${instance.constructor.name} declares the column '${expression}' outside a public field; ` +
        'write each column as `name = this.column(...)`'
    )
  }
}

/** A DTO or view class: an engine's `defineDto()`/`defineView()` base, or any class extending one. */
export type DtoClass<Root extends string = string> = (new () => { readonly fhirType: Root }) & {
  readonly fhirType: Root
}

/** The DTO instance type returned by projection, including getters and methods. */
export type DtoRow<C extends DtoClass> = InstanceType<C>

/** The resource names that are `Root` or derive from it: every resource for `Resource`. */
export type SubtypesOf<Root extends string> = {
  [Name in keyof R4Resources]: DerivesFrom<Name, Root> extends true ? Name : never
}[keyof R4Resources]

/**
 * What a resource root accepts: a value carrying its `resourceType`, or one of
 * the resource names deriving from an abstract root such as `Resource`. The
 * rule is the runtime's, a root that derives from `Resource` in the model. A
 * datatype root accepts any object.
 */
type RootInput<Root extends string> =
  DerivesFrom<Root, 'Resource'> extends true
    ? Root extends keyof R4Resources
      ? { readonly resourceType: Root }
      : { readonly resourceType: SubtypesOf<Root> }
    : object

type IsAny<Type> = 0 extends 1 & Type ? true : false

/** The paths the required columns of an instance carry (see `RequiredColumn`). */
type RequiredPaths<Instance> = {
  [Key in keyof Instance]: IsAny<Instance[Key]> extends true
    ? never
    : Instance[Key] extends RequiredColumn<infer Path extends string>
      ? Path
      : never
}[keyof Instance]

type RequiredInput<Root extends string, Paths extends string> = UnionToIntersection<
  Paths extends Paths ? RequiredPathInput<Root, Paths> : never
>

/**
 * A Bundle input for a class, or a refusal. A Bundle is accepted as a whole,
 * so its entries are typed only at runtime, and the runtime never checks a
 * required path; a class with a required column therefore takes no Bundle,
 * and the caller reads the entries with `ofType()` and narrows them instead.
 */
export type BundleInput<C extends DtoClass> = [RequiredPaths<InstanceType<C>>] extends [never]
  ? BundleLike
  : {
      // The pin makes TypeScript elaborate a refused Bundle against this member, so the error names the recipe.
      readonly resourceType: 'Bundle'
      readonly bundleNotAccepted: 'this DTO has required columns, which a Bundle entry cannot prove; read the entries with Bundle.entry.resource.ofType(...) and narrow them'
    }

/**
 * One subject is never a Bundle: the runtime unwraps a Bundle into its entries
 * and returns one row per entry, so a Bundle enters only through `BundleInput`.
 * A `Resource` root would otherwise admit one through `SubtypesOf`, and a
 * datatype root through `object`.
 */
type NotBundle = { readonly resourceType?: Exclude<keyof R4Resources, 'Bundle'> }

/**
 * What a DTO or view projects: one subject, an array of them, or a Bundle. A
 * Bundle and an array give one row per entry; one subject gives one row.
 */
export type DtoProjectionInput<C extends DtoClass> = readonly DtoInput<C>[] | BundleInput<C> | (DtoInput<C> & NotBundle)

/** The rows a projection returns for its input, by the same rule the runtime applies. */
export type DtoProjection<C extends DtoClass, Input> = Input extends readonly unknown[] | BundleLike
  ? InstanceType<C>[]
  : InstanceType<C>

/**
 * The input a DTO or view projects: its root's `resourceType` (any object for
 * a datatype root), plus every path its required columns read. Base classes
 * contribute their required columns through the instance type.
 */
export type DtoInput<C extends DtoClass> = RootInput<C['fhirType']> &
  RequiredInput<C['fhirType'], RequiredPaths<InstanceType<C>>>

/**
 * The class `defineDto()`/`defineView()` returns: a base bound to one FHIR type
 * and its column context. `Fields` adds the columns of a class a function
 * builds on that base, for writing such a function's return type.
 */
export type DtoBaseClass<
  Root extends string,
  Context extends object,
  Fields extends object = object,
  Kind extends DtoKind = DtoKind,
  Own extends object = EmptyFhirpathTypeContext,
> = (new () => DtoBase<Root, Context, Kind> & Fields) & {
  readonly fhirType: Root
  /**
   * Type-only, nothing at runtime: the class's own context (`DtoContext`), which
   * a class using this one as `base` inherits, and its kind, which decides
   * what may use it as `base`.
   */
  readonly [dtoTypes]: { readonly context: Own; readonly kind: Kind }
  /**
   * Projects on the defining engine: one row per input resource, typed like the
   * engine's `project()`. The input must carry the root's `resourceType` and
   * every required column's path.
   */
  from<This extends DtoClass, const Input extends DtoProjectionInput<This>>(
    this: This,
    input: Input,
    options?: EvaluateOptions
  ): DtoProjection<This, Input>
}

/** The class a registered DTO is: every non-method instance field is a column. */
export type RegisteredDtoClass = (new () => { readonly fhirType: string } & DtoBase<string, object, 'dto'>) & {
  readonly fhirType: string
}

type NonColumnKey = 'fhirType'

/** A registered DTO's column names: its non-method instance fields. */
type ColumnNames<Instance> = {
  [Key in keyof Instance]: Key extends NonColumnKey
    ? never
    : Instance[Key] extends (...args: never[]) => unknown
      ? never
      : Key
}[keyof Instance] &
  string

/**
 * Type names by the TypeScript form of their values. Generic over the model maps
 * so they resolve only when a registered column needs them, and then once.
 */
type ElementlessTypeName<TypeOf, Elements> = Exclude<keyof TypeOf, keyof Elements>
type TypeNameHolding<TypeOf, Elements, Value> = {
  [Name in ElementlessTypeName<TypeOf, Elements>]: TypeOf[Name] extends Value ? Name : never
}[ElementlessTypeName<TypeOf, Elements>]
/** Model types an object value may be: every type with elements, and the System quantity. */
type ObjectTypeName<TypeOf, Elements> =
  | Extract<keyof Elements, keyof TypeOf>
  | Exclude<
      ElementlessTypeName<TypeOf, Elements>,
      TypeNameHolding<TypeOf, Elements, string | number | boolean | bigint>
    >

/** Marks a member no FHIR type represents, which makes the whole result undeclared. */
type Unmapped = '~unmapped'

/**
 * Every FHIR type whose TypeScript form is this value type. A TypeScript
 * `string` may be a FHIR `string`, `code`, `uri`, and more, so the answer is
 * their union: naming one of them would let `ofType()` drop a value the
 * runtime returns.
 */
type TypeNamesOf<Value, TypeOf = R4TypeOf, Elements = R4Elements> = Value extends string
  ? TypeNameHolding<TypeOf, Elements, string>
  : Value extends number
    ? TypeNameHolding<TypeOf, Elements, number>
    : Value extends boolean
      ? TypeNameHolding<TypeOf, Elements, boolean>
      : Value extends object
        ? {
            [Name in ObjectTypeName<TypeOf, Elements>]: [Value] extends [TypeOf[Name]]
              ? [TypeOf[Name]] extends [Value]
                ? Name
                : never
              : never
          }[ObjectTypeName<TypeOf, Elements>] extends infer Names extends string
          ? [Names] extends [never]
            ? Unmapped
            : Names
          : Unmapped
        : Unmapped

type ColumnElement<Value> = Value extends readonly (infer Item)[] ? Item : Value

/**
 * A column as the expression-defined function registration makes it. The body
 * text is not in the class type, so the declared result is all the call has; with
 * no result, the call stays opaque.
 */
type ColumnFunction<Root extends string, Value> = unknown extends Value
  ? OpaqueColumnFunction<Root>
  : TypeNamesOf<ColumnElement<Exclude<Value, null | undefined>>> extends infer Names extends string
    ? [Names] extends [never]
      ? OpaqueColumnFunction<Root>
      : Unmapped extends Names
        ? OpaqueColumnFunction<Root>
        : {
            readonly expression: string
            readonly signature: {
              readonly input: { readonly types: readonly [Root] }
              readonly result: { readonly types: readonly Names[] }
            }
          }
    : never

type OpaqueColumnFunction<Root extends string> = {
  readonly expression: string
  readonly signature: { readonly input: { readonly types: readonly [Root] } }
}

type DeclarationsNamed<Dtos extends readonly unknown[], Name extends string> = Dtos extends readonly [
  infer Head,
  ...infer Tail,
]
  ? Head extends RegisteredDtoClass
    ? Name extends ColumnNames<InstanceType<Head>>
      ? [ColumnFunction<Head['fhirType'], InstanceType<Head>[Name]>, ...DeclarationsNamed<Tail, Name>]
      : DeclarationsNamed<Tail, Name>
    : DeclarationsNamed<Tail, Name>
  : []

/**
 * The FHIRPath functions a list of registered DTOs adds, in the shape
 * `EvaluateOptions.functions` declares: one per column name, with an overload
 * per DTO that declares it.
 */
type AllColumnNames<Dto> = Dto extends RegisteredDtoClass ? ColumnNames<InstanceType<Dto>> : never

type DeclarationList<Declaration> = Declaration extends { readonly overloads: infer List extends readonly unknown[] }
  ? List
  : readonly [Declaration]

/** Function declarations with more added: a name both declare becomes one overload list, as at runtime. */
type AddFunctionDeclarations<Existing, Added> = {
  readonly [Name in keyof Existing | keyof Added]: Name extends keyof Added
    ? Name extends keyof Existing
      ? { readonly overloads: readonly [...DeclarationList<Existing[Name]>, ...DeclarationList<Added[Name]>] }
      : Added[Name]
    : Name extends keyof Existing
      ? Existing[Name]
      : never
}

type FunctionsOption<Options> = Options extends { readonly functions?: infer Functions }
  ? Exclude<Functions, undefined>
  : EmptyFhirpathTypeContext

/**
 * The options type of the engine `register()` returns: the same options, with
 * each registered column added to `functions`. Keeping them there means a call
 * on an engine types exactly as a host function declared at construction.
 */
export type RegisteredOptions<Options, Added extends readonly unknown[]> = {
  readonly [Key in keyof Options | 'functions']: Key extends 'functions'
    ? AddFunctionDeclarations<FunctionsOption<Options>, DtoFunctions<Added>>
    : Key extends keyof Options
      ? Options[Key]
      : never
}

export type DtoFunctions<Dtos extends readonly unknown[]> = {
  readonly [Name in AllColumnNames<Dtos[number]>]: DeclarationsNamed<Dtos, Name> extends readonly [infer Only]
    ? Only
    : { readonly overloads: DeclarationsNamed<Dtos, Name> }
}

/** Everything a DTO class was declared with; `project()`, the engine, and `analyzeDto` all read it from here. */
export interface DtoDefinition {
  /** The engine whose `defineDto()`/`defineView()` created the base. */
  readonly engine: FhirPathEngine
  readonly kind: DtoKind
  readonly fhirType: string
  /** Whether `fhirType` is a resource type of the engine's model; false without a model. */
  readonly resource: boolean
  /** A column always records an object form, so a consumer never has to handle the plain-string column. */
  readonly columns: Readonly<Record<string, ColumnSpec>>
  /**
   * The root each column is checked against: the base's root for a column
   * inherited unchanged, since it was written for that root and a subtype
   * carries every element of its base; this root for the rest.
   */
  readonly columnRoots: Readonly<Record<string, string>>
  /** How many columns were declared while the class was collected, redeclarations included. */
  readonly collected: number
  /** The DTO's own environment values, with bare names. */
  readonly env: Record<string, unknown> | undefined
  /**
   * What a column body reads: the defining engine's env with the DTO's own env
   * over it. Column types were inferred from these values, so both routes to a
   * column apply them over the caller's.
   */
  readonly columnEnv: Record<string, unknown> | undefined
  readonly vars: Record<string, AnyExpression | readonly TypedValue[]> | undefined
  /** Env names the projecting call supplies (see DtoOptions.callerEnv). */
  readonly callerEnvNames: readonly string[]
  /** Static types for the caller environment, when declared. */
  readonly callerEnvTypes: FhirpathTypeDeclarations | undefined
}

type DtoBaseDefinition = Omit<DtoDefinition, 'columns' | 'columnRoots' | 'collected'> & {
  /** The `base` option, whose definition supplies the inherited columns' roots. */
  readonly base: DtoClass | undefined
}

/** The normalized options a `defineDto()` base was created with. */
const bases = new WeakMap<object, DtoBaseDefinition>()

/** Definitions already collected, keyed by the DTO class. */
const definitions = new WeakMap<object, DtoDefinition>()

/**
 * Creates the base class behind `engine.defineDto()` and `engine.defineView()`.
 * The type becomes the context for relative column paths, and the options
 * become the variables the columns can read. The engine's own env names are
 * refused as `callerEnv`, because a column always reads the engine's value.
 */
export function createDtoBase(
  engine: FhirPathEngine,
  kind: DtoKind,
  fhirType: string,
  options: DtoDefinitionOptions = {}
): DtoBaseClass<string, object> {
  const inherited = options.base === undefined ? undefined : inheritedDefinition(kind, fhirType, options.base, engine)
  // Extending the base class itself is what inherits its columns, methods, and
  // getters: the base's field initializers run when this class is constructed,
  // so its columns are collected with the subclass's own.
  const parent = (options.base ?? DtoBase) as typeof DtoBase
  const base = class extends parent {
    static from(this: DtoClass, input: unknown, options?: EvaluateOptions): unknown {
      return engine.project(input as never, this, options)
    }
  }
  // A readable name for project()/registration errors; a subclass replaces it.
  Object.defineProperty(base, 'name', { value: `${fhirType}${kind === 'dto' ? 'Dto' : 'View'}` })
  Object.defineProperty(base, 'fhirType', { value: fhirType, enumerable: true })
  bases.set(base, baseDefinition(engine, kind, fhirType, options, inherited))
  return base as unknown as DtoBaseClass<string, object>
}

/**
 * Checks a `base` option: a DTO or view class whose kind the subclass's kind
 * accepts and whose root is this root or one of its model base types. The
 * engine lineage is checked by `defineDto()`/`defineView()`, which know their
 * engine's parents.
 */
function inheritedDefinition(
  kind: DtoKind,
  fhirType: string,
  base: DtoClass,
  engine: FhirPathEngine
): DtoBaseDefinition {
  const call = `${kind === 'dto' ? 'defineDto' : 'defineView'}('${fhirType}')`
  const definition = baseOf(base)
  if (definition === undefined) {
    throw new FhirPathTypeError(`${call}: base ${describeClass(base)} is not a class from defineDto() or defineView()`)
  }
  if (kind === 'dto' && definition.kind === 'view') {
    throw new FhirPathTypeError(
      `${call}: base ${base.name} is a view; a DTO takes a DTO as base, a view takes a DTO or a view`
    )
  }
  const { model } = engine.defaults
  if (!derivesFrom(model, fhirType, definition.fhirType)) {
    throw new FhirPathTypeError(
      model === undefined
        ? `${call}: base ${base.name} is written for ${definition.fhirType}; without a model only a base of the same type is allowed`
        : `${call}: base ${base.name} is written for ${definition.fhirType}, which is not a base type of ${fhirType}`
    )
  }
  return definition
}

function describeClass(value: unknown): string {
  return typeof value === 'function' && value.name !== '' ? value.name : String(value)
}

/**
 * Checks and normalizes the options once, when the base is created. With a
 * `base`, its env, vars, and caller environment sit under this class's own, so
 * the subclass wins on a name clash, as its columns do.
 */
function baseDefinition(
  engine: FhirPathEngine,
  kind: DtoKind,
  fhirType: string,
  options: DtoDefinitionOptions,
  inherited: DtoBaseDefinition | undefined
): DtoBaseDefinition {
  const call = `${kind === 'dto' ? 'defineDto' : 'defineView'}('${fhirType}')`
  const { env, vars, callerEnv } = options
  if (env !== undefined && (typeof env !== 'object' || env === null || Array.isArray(env))) {
    throw new FhirPathTypeError(`${call}: 'env' must be a record of variables, the same shape as EvaluateOptions.env`)
  }
  const ownEnv = env === undefined ? undefined : normalizeEnvKeys(env)
  const callerEnvIsNames = isCallerEnvNames(callerEnv)
  const ownCallerEnvNames = (callerEnvIsNames ? callerEnv : Object.keys(callerEnv ?? {})).map(bareEnvironmentName)
  if (inherited !== undefined) {
    // The inherited columns were typed against the base's bindings, and the
    // runtime would read this class's, so a name the base binds stays its own.
    const own = new Set([...Object.keys(ownEnv ?? {}), ...Object.keys(normalizeEnvKeys(vars)), ...ownCallerEnvNames])
    const rebound = [
      ...Object.keys(inherited.env ?? {}),
      ...Object.keys(normalizeEnvKeys(inherited.vars)),
      ...inherited.callerEnvNames,
    ].find(name => own.has(name))
    if (rebound !== undefined) {
      throw new FhirPathTypeError(
        `${call}: '${rebound}' is bound by the base's env, vars, or callerEnv; the inherited columns were typed against it, so a subclass cannot rebind it`
      )
    }
  }
  const normalizedEnv = compact({ ...inherited?.env, ...ownEnv })
  const callerEnvNames = [...(inherited?.callerEnvNames ?? []), ...ownCallerEnvNames]
  // The DTO's own value always wins, so a caller value under the same name would never be read.
  const shadowed = callerEnvNames.find(name => normalizedEnv !== undefined && Object.hasOwn(normalizedEnv, name))
  if (shadowed !== undefined) {
    throw new FhirPathTypeError(`${call}: callerEnv names '${shadowed}', which the DTO's own env already binds`)
  }
  const engineEnv = normalizeEnvKeys(engine.defaults.env)
  const engineOwned = callerEnvNames.find(name => Object.hasOwn(engineEnv, name))
  if (engineOwned !== undefined) {
    throw new FhirPathTypeError(
      `${call}: callerEnv names '${engineOwned}', which the engine's env binds; a column always reads the engine's value`
    )
  }
  const { model } = engine.defaults
  return {
    engine,
    kind,
    fhirType,
    resource: model !== undefined && derivesFrom(model, fhirType, 'Resource'),
    env: normalizedEnv,
    columnEnv: compact({ ...engineEnv, ...normalizedEnv }),
    vars: compact({ ...inherited?.vars, ...vars }),
    callerEnvNames,
    callerEnvTypes: compact({ ...inherited?.callerEnvTypes, ...(callerEnvIsNames ? undefined : callerEnv) }),
    base: options.base,
  }
}

/** A merged record, or `undefined` when nothing was declared, so an empty overlay costs nothing per call. */
function compact<Value>(record: Record<string, Value>): Record<string, Value> | undefined {
  return Object.keys(record).length > 0 ? record : undefined
}

/**
 * Whether `type` is `base` or derives from it in the model: a Patient is a
 * Resource and a DomainResource. Without a model only the type itself.
 */
function derivesFrom(model: ModelProvider | undefined, type: string, base: string): boolean {
  if (type === base) {
    return true
  }
  if (model === undefined) {
    return false
  }
  const canonical = canonicalFocusType(model, type)
  const baseCanonical = canonicalFocusType(model, base)
  return (
    canonical !== undefined &&
    baseCanonical !== undefined &&
    (canonical === baseCanonical || model.isSubtypeOf(canonical, baseCanonical))
  )
}

function isCallerEnvNames(
  callerEnv: readonly string[] | FhirpathTypeDeclarations | undefined
): callerEnv is readonly string[] {
  return Array.isArray(callerEnv)
}

/** The engine-created base a class descends from, with the options it fixed. */
function baseOf(cls: object): DtoBaseDefinition | undefined {
  for (let current: unknown = cls; typeof current === 'function'; current = Object.getPrototypeOf(current)) {
    const base = bases.get(current)
    if (base !== undefined) {
      return base
    }
  }
  return undefined
}

/**
 * Whether a value is a DTO or view class — a base an engine created, or a
 * subclass of one. Lets tooling pick the DTOs out of a module's exports (see the
 * `fhirpath-check` CLI) without instantiating anything that is not one.
 */
export function isDtoClass(value: unknown): value is DtoClass {
  return typeof value === 'function' && baseOf(value) !== undefined
}

/**
 * Collects and caches a DTO's type, columns, environment, variables, and caller
 * environment names. Columns are read by constructing the class once: each
 * `this.column()` initializer leaves a marker in its field.
 */
export function dtoDefinition(cls: DtoClass): DtoDefinition {
  const cached = definitions.get(cls)
  if (cached !== undefined) {
    return cached
  }
  const base = baseOf(cls)
  if (base === undefined) {
    throw new FhirPathTypeError(
      `${cls.name || 'The class'} is not a DTO class; extend engine.defineDto('<fhirType>') or engine.defineView('<fhirType>')`
    )
  }
  const found: ColumnMarker[] = []
  collecting.set(cls, found)
  let instance: object
  try {
    instance = new cls()
  } finally {
    collecting.delete(cls)
  }
  assertLastMarkerStored(instance, found)
  // The base's initializers run first, so its markers lead `found`; a column
  // whose marker is among them was inherited unchanged.
  const parent = base.base === undefined ? undefined : dtoDefinition(base.base)
  const inheritedMarkers = parent?.collected ?? 0
  const columns: Record<string, ColumnSpec> = {}
  const columnRoots: Record<string, string> = {}
  for (const [name, value] of Object.entries(instance)) {
    if (value instanceof ColumnMarker) {
      columns[name] = value.spec
      columnRoots[name] =
        parent !== undefined && found.indexOf(value) < inheritedMarkers
          ? (parent.columnRoots[name] ?? base.fhirType)
          : base.fhirType
    }
  }
  if (Object.keys(columns).length === 0) {
    throw new FhirPathTypeError(`DTO ${cls.name} declares no columns; add a field such as \`id = this.column('id')\``)
  }
  // TypeScript rejects a field that shadows the fhirType accessor; transpile-only code reaches this.
  if ('fhirType' in columns) {
    throw new FhirPathTypeError(`DTO ${cls.name} declares a column named 'fhirType', which every row already carries`)
  }
  if (base.kind === 'dto') {
    const converted = Object.entries(columns).find(([, spec]) => 'as' in spec || 'choices' in spec)
    if (converted !== undefined) {
      throw new FhirPathTypeError(
        `DTO ${cls.name} column '${converted[0]}' converts its value with 'as' or 'choices'; ` +
          'a registered column returns its expression result, so convert values in a view'
      )
    }
  }
  const definition: DtoDefinition = { ...base, columns, columnRoots, collected: found.length }
  definitions.set(cls, definition)
  return definition
}

/**
 * Checks that a class can be registered: a DTO rather than a view, holding only
 * columns and methods. The engine's types read every non-method field of a
 * registered DTO as a column, so a getter or a plain field would claim a
 * function that does not exist.
 */
export function assertRegistrable(cls: DtoClass): DtoDefinition {
  const definition = dtoDefinition(cls)
  if (definition.kind === 'view') {
    throw new FhirPathTypeError(`${cls.name} is a view; only classes from engine.defineDto() can be registered`)
  }
  const plain = Object.keys(new cls()).find(name => !Object.hasOwn(definition.columns, name))
  if (plain !== undefined) {
    throw new FhirPathTypeError(
      `DTO ${cls.name} has a field '${plain}' that is not a column; a registered DTO holds only columns and methods`
    )
  }
  for (
    let current: unknown = cls.prototype;
    current !== DtoBase.prototype && current !== null;
    current = Object.getPrototypeOf(current)
  ) {
    const getter = Object.entries(Object.getOwnPropertyDescriptors(current)).find(
      ([name, descriptor]) => name !== 'fhirType' && (descriptor.get !== undefined || descriptor.set !== undefined)
    )
    if (getter !== undefined) {
      throw new FhirPathTypeError(
        `DTO ${cls.name} has an accessor '${getter[0]}'; a registered DTO holds only columns and methods, so move it to a view`
      )
    }
  }
  return definition
}

/**
 * Adds DTO columns to the engine's function table. Each function keeps its DTO
 * input type and environment. Same-name functions become overloads when their
 * input types do not overlap.
 */
export function withDtos(defaults: EvaluateOptions, dtos: readonly DtoClass[], compile: Compiler): EvaluateOptions {
  if (dtos.length === 0) {
    return defaults
  }
  const { model } = defaults
  if (model === undefined) {
    // The model selects a column from the call focus and separates same-name columns.
    throw new FhirPathTypeError(
      `Registering DTOs (${dtos.map(dto => dto.name).join(', ')}) needs a model; ` +
        'a column is written for one type, and without a model the engine cannot check a call against it. ' +
        'Pass model to the engine, or project the DTO without registering it.'
    )
  }
  const functions: Record<string, CustomFunction> = { ...defaults.functions }
  for (const dto of dtos) {
    addColumns(functions, dto, columnFunctionSet(dto, compile).own, model)
  }
  return { ...defaults, functions }
}

/** A DTO's own column functions, and the function table their bodies call. */
interface ColumnFunctionSet {
  readonly own: Readonly<Record<string, ColumnCustomFunction>>
  readonly table: Readonly<Record<string, CustomFunction>>
}

/** Function sets already built, one per definition. */
const functionSets = new WeakMap<DtoDefinition, ColumnFunctionSet>()

/**
 * The functions a DTO's column bodies call: its defining engine's, with a
 * registered DTO's own columns added the way `register()` adds them. Fixed with
 * the definition, like `columnEnv`, so a caller's function of the same name
 * cannot change what a column's type describes. Each column function carries
 * the table it belongs to.
 */
function columnFunctionSet(dto: DtoClass, compile: Compiler): ColumnFunctionSet {
  const definition = dtoDefinition(dto)
  const cached = functionSets.get(definition)
  if (cached !== undefined) {
    return cached
  }
  const table: Record<string, CustomFunction> = { ...definition.engine.defaults.functions }
  const own: Record<string, ColumnCustomFunction> = {}
  if (definition.kind === 'dto') {
    for (const [name, spec] of Object.entries(definition.columns)) {
      own[name] = columnFunction(spec, compile, definition, table)
    }
    addColumns(table, dto, own, definition.engine.defaults.model)
  }
  // Recorded only once complete, so a DTO that cannot join its engine's
  // functions fails the same way on every route.
  const set = { own, table }
  functionSets.set(definition, set)
  return set
}

/** The function table a DTO's column bodies call (see `columnFunctionSet`). */
export function columnFunctionTable(dto: DtoClass, compile: Compiler): Readonly<Record<string, CustomFunction>> {
  return columnFunctionSet(dto, compile).table
}

/**
 * Adds a DTO's columns to a function table. A name another declaration already
 * uses becomes an overload when the focus type tells them apart.
 */
function addColumns(
  into: Record<string, CustomFunction>,
  dto: DtoClass,
  own: Readonly<Record<string, ColumnCustomFunction>>,
  model: ModelProvider | undefined
): void {
  for (const [name, column] of Object.entries(own)) {
    // Without this, createContext fails later and names the function rather
    // than the field that caused it.
    if (builtinFunctions.has(name)) {
      throw new FhirPathTypeError(
        `DTO ${dto.name} declares a column named '${name}', which is a built-in function; rename the field`
      )
    }
    into[name] = declaredWith(into[name], column, model, () => `DTO ${dto.name} redefines the function '${name}'`)
  }
}

/** Adds a column declaration when its focus type distinguishes it from every existing declaration. */
function declaredWith(
  existing: CustomFunction | undefined,
  column: SingleCustomFunction,
  model: ModelProvider | undefined,
  blamed: () => string
): CustomFunction {
  if (existing === undefined) {
    return column
  }
  if (model === undefined) {
    throw new FhirPathTypeError(`${blamed()}: telling same-name functions apart by focus type needs a model`)
  }
  const declared = 'overloads' in existing ? existing.overloads : [existing]
  for (const other of declared) {
    const reason = indistinguishable(model, other, column)
    if (reason !== undefined) {
      throw new FhirPathTypeError(`${blamed()}: ${reason}`)
    }
  }
  return { overloads: [...declared, column] }
}

/**
 * Explains why focus-only dispatch cannot separate two declarations. Each side
 * must declare input types, and those types must not overlap.
 */
function indistinguishable(model: ModelProvider, a: SingleCustomFunction, b: SingleCustomFunction): string | undefined {
  const wanted = canonicalTypes(model, a.signature?.input?.types)
  const claimed = canonicalTypes(model, b.signature?.input?.types)
  if (wanted === undefined || claimed === undefined) {
    return 'a declaration that names no input type answers every call, so nothing else may share its name'
  }
  const overlap = wanted.flatMap(one =>
    claimed.filter(other => typesOverlap(model, one, other)).map(other => [one, other])
  )
  const pair = overlap[0]
  if (pair === undefined) {
    return undefined
  }
  // Equal types make the field name ambiguous, even though the type itself is clear.
  return pair[0] === pair[1] ? `both are written for ${pair[0]}` : `a focus can be both ${pair[0]} and ${pair[1]}`
}

/** Declared input types as the model names them, or undefined when the name declares none the model knows. */
function canonicalTypes(model: ModelProvider, types: readonly string[] | undefined): string[] | undefined {
  if (types === undefined) {
    return undefined
  }
  const canonical = types
    .map(type => canonicalFocusType(model, type))
    .filter((type): type is string => type !== undefined)
  return canonical.length === 0 ? undefined : canonical
}

/**
 * Converts a DTO column into a typed expression function that reads its
 * definition's env (see `DtoDefinition.columnEnv`). Criteria functions also carry the criteria Boolean rule. DTO
 * variables remain projection-only because function calls have no row.
 */
function columnFunction(
  spec: ColumnSpec,
  compile: Compiler,
  dto: DtoDefinition,
  functions: Record<string, CustomFunction>
): ColumnCustomFunction {
  const { fhirType, columnEnv: env } = dto
  if ('test' in spec) {
    return {
      expression: compile(spec.test),
      criteria: true,
      signature: criteriaSignature(fhirType),
      ...(env !== undefined && { env }),
      [COLUMN_FUNCTIONS]: functions,
    }
  }
  const signature = columnSignature(spec, fhirType)
  return {
    expression: compile(spec.path),
    ...(signature !== undefined && { signature }),
    ...(env !== undefined && { env }),
    [COLUMN_FUNCTIONS]: functions,
  }
}

/**
 * Checks each subject against the DTO type before projection. Without this
 * check, a wrong value could produce a typed row filled with defaults. A
 * resource root demands an object carrying its `resourceType`; a datatype root
 * has no `resourceType` to check, and without a model only a present
 * `resourceType` is compared.
 */
export function assertInputMatchesDto(input: unknown, dto: DtoClass): void {
  const { fhirType, resource, engine } = dtoDefinition(dto)
  const { model } = engine.defaults
  toSubjects(input).forEach((subject, index) => {
    const { value } = subject
    const resourceType =
      typeof value === 'object' && value !== null ? (value as { resourceType?: unknown }).resourceType : undefined
    if (typeof resourceType === 'string' && !derivesFrom(model, resourceType, fhirType)) {
      throw new FhirPathTypeError(
        `project(): row ${index} is a ${resourceType}, but ${dto.name} declares fhirType '${fhirType}'`
      )
    }
    if (!resource) {
      return
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new FhirPathTypeError(
        `project(): row ${index} is ${describeValue(value)}, not a resource, but ${dto.name} declares fhirType '${fhirType}'`
      )
    }
    if (typeof resourceType !== 'string') {
      throw new FhirPathTypeError(
        `project(): row ${index} has no resourceType, but ${dto.name} declares fhirType '${fhirType}'`
      )
    }
  })
}

/** A short description of a non-resource value for an error message; never its contents. */
function describeValue(value: unknown): string {
  if (value === null) {
    return 'null'
  }
  if (Array.isArray(value)) {
    return 'an array'
  }
  return `a ${typeof value}`
}

/**
 * Merges DTO options with call options. Definition values win, so projected and
 * registered columns read the same env and functions, and a column's inferred
 * type cannot be changed by a caller's value of the same name.
 */
export function dtoCallOptions(
  dto: DtoClass,
  options: EvaluateOptions | undefined,
  compile: Compiler
): EvaluateOptions {
  const definition = dtoDefinition(dto)
  const { columnEnv: env, vars } = definition
  const merged: EvaluateOptions = {
    ...options,
    functions: { ...options?.functions, ...columnFunctionTable(dto, compile) },
  }
  if (env !== undefined) {
    merged.env = mergeEnvKeys(options?.env, env)
  }
  if (vars !== undefined) {
    // DTO vars keep their declaration order; a caller var adds only names the DTO leaves free.
    const own = normalizeEnvKeys(vars)
    merged.vars = {
      ...own,
      ...Object.fromEntries(
        Object.entries(normalizeEnvKeys(options?.vars)).filter(([name]) => !Object.hasOwn(own, name))
      ),
    }
  }
  return merged
}
