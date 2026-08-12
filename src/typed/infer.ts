import type { R4Resources, R4TypeOf } from '../r4/generated/type-maps.ts'
import type {
  BareContextName,
  ContextProperty,
  EmptyContextMap,
  MergeContextMaps,
  NormalizeContextMap,
} from './context-maps.ts'
import type { InferTypeExpression } from './parser.ts'

/** A type name known by the generated R4 model. */
export type FhirTypeName = keyof R4TypeOf & string
export type EmptyFhirpathTypeContext = EmptyContextMap

/** A host declaration that the type-level evaluator can use without reading a runtime value. */
export interface FhirpathTypeDeclaration<
  Type extends FhirTypeName = FhirTypeName,
  Collection extends boolean = boolean,
> {
  /** One candidate type, or every candidate a value may hold. */
  type: Type | readonly Type[]
  /** Omitted means at most one item; true means the value may contain many. */
  collection?: Collection
  /** Resource targets when `type` includes Reference. */
  targets?: FhirTypeName | readonly FhirTypeName[]
}

export type FhirpathTypeDeclarations = Readonly<Record<string, FhirpathTypeDeclaration>>

/** The static fields of a native, expression-defined, or overloaded custom function. */
export type FhirpathFunctionDeclaration =
  | {
      readonly signature?: {
        readonly input?: { readonly types?: readonly string[] }
        readonly args?: readonly string[]
        readonly result?: { readonly types?: readonly string[]; readonly single?: boolean }
      }
      readonly expression?: string | { readonly source: string }
      readonly criteria?: boolean
      readonly envTypes?: FhirpathTypeDeclarations
    }
  | { readonly overloads: readonly FhirpathFunctionDeclaration[] }

/** Type information supplied by a host around a literal FHIRPath expression. */
export interface FhirpathTypeContext {
  env?: FhirpathTypeDeclarations
  vars?: FhirpathTypeDeclarations
  /** The same declarations accepted by `EvaluateOptions.functions`. */
  functions?: Readonly<Record<string, FhirpathFunctionDeclaration>>
}

/** The inferred result of evaluating a literal FHIRPath expression. */
export type FhirpathResult<
  Expression extends string,
  Context extends FhirpathTypeContext = EmptyFhirpathTypeContext,
> = FhirpathResultIn<Expression, 'opaque', Context>

/**
 * The inferred result with an explicit FHIR input type. Non-literal,
 * malformed, over-budget, or unsupported expressions safely become
 * `unknown[]`.
 */
export type FhirpathResultIn<
  Expression extends string,
  Input extends string,
  Context extends FhirpathTypeContext = EmptyFhirpathTypeContext,
> = FhirpathResultForContext<Expression, Input, Context>

/** Internal inference entry point for contexts assembled from generic API options. */
export type FhirpathResultForContext<
  Expression extends string,
  Input extends string,
  Context extends object = EmptyFhirpathTypeContext,
> = string extends Expression ? unknown[] : InferTypeExpression<Expression, Input, Context>

/** Merge contexts by normalized name. The later context wins, matching per-call runtime options. */
export type MergeFhirpathTypeContexts<Base extends object, Overlay extends object> = {
  env: MergeContextMaps<ContextProperty<Base, 'env'>, ContextProperty<Overlay, 'env'>>
  vars: MergeContextMaps<ContextProperty<Base, 'vars'>, ContextProperty<Overlay, 'vars'>>
  functions: MergeContextMaps<ContextProperty<Base, 'functions'>, ContextProperty<Overlay, 'functions'>>
}

type LiteralVarDeclaration<Value> = Value extends string
  ? string extends Value
    ? FhirpathTypeDeclaration
    : FhirpathTypeDeclaration & { readonly __expression: Value }
  : Value extends { readonly source: infer Source extends string }
    ? string extends Source
      ? FhirpathTypeDeclaration
      : FhirpathTypeDeclaration & { readonly __expression: Source }
    : FhirpathTypeDeclaration

type LiteralVarDeclarations<Values> =
  Values extends Readonly<Record<PropertyKey, unknown>>
    ? { readonly [Name in keyof Values]: LiteralVarDeclaration<Values[Name]> }
    : EmptyFhirpathTypeContext

/** The inference context retained from one literal engine or per-call options object. */
export type FhirpathTypeContextOf<Options> = {
  env: NormalizeContextMap<ContextProperty<Options, 'envTypes'>>
  vars: MergeContextMaps<LiteralVarDeclarations<ContextProperty<Options, 'vars'>>, ContextProperty<Options, 'varTypes'>>
  functions: NormalizeContextMap<ContextProperty<Options, 'functions'>>
}

type DeclarationElement<Declaration> = Declaration extends { readonly type: infer Type }
  ? Type extends readonly FhirTypeName[]
    ? R4TypeOf[Type[number]]
    : Type extends FhirTypeName
      ? R4TypeOf[Type]
      : unknown
  : unknown

type DeclaredHostValue<Declaration> = Declaration extends { readonly collection: true }
  ? DeclarationElement<Declaration> | readonly DeclarationElement<Declaration>[] | undefined
  : DeclarationElement<Declaration> | readonly [] | readonly [DeclarationElement<Declaration>] | undefined

type ConstrainedDeclaredValues<Values, Declarations> =
  Values extends Readonly<Record<PropertyKey, unknown>>
    ? {
        [Name in keyof Values]: LookupNormalizedDeclaration<Declarations, Name> extends infer Declaration
          ? [Declaration] extends [never]
            ? Values[Name]
            : Values[Name] extends DeclaredHostValue<Declaration>
              ? Values[Name]
              : never
          : Values[Name]
      }
    : Values

type LookupNormalizedDeclaration<Declarations, Name extends PropertyKey> =
  BareContextName<Name> extends keyof NormalizeContextMap<Declarations>
    ? NormalizeContextMap<Declarations>[BareContextName<Name>]
    : never

/** Cross-check declarations and values when both remain visible in one literal options object. */
export type CheckedFhirpathOptionValues<Options> = Options extends {
  readonly env: infer Env
  readonly envTypes: infer EnvTypes
}
  ? { readonly env: ConstrainedDeclaredValues<Env, EnvTypes> }
  : unknown

/** A model root known from a resource-shaped input; ambiguous and structural inputs stay opaque. */
export type FhirpathRootOf<Input> = Input extends readonly (infer Item)[]
  ? FhirpathRootOf<Item>
  : Input extends { readonly resourceType: infer Root extends FhirTypeName }
    ? Root
    : 'opaque'

/** The expected input resource for a resource-rooted literal expression. */
export type FhirpathInput<Expression extends string> = string extends Expression
  ? unknown
  : Expression extends `${infer Root}.${string}`
    ? Root extends keyof R4Resources
      ? R4Resources[Root]
      : unknown
    : Expression extends keyof R4Resources
      ? R4Resources[Expression]
      : unknown
