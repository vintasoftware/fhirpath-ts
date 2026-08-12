/** An empty host context that contributes no known keys. */
export type EmptyContextMap = Record<never, never>

/** Preserve host values for best-effort type inference without exposing them as declarations. */
export type HostValueDeclarations<Values> =
  Values extends Readonly<Record<PropertyKey, unknown>>
    ? { readonly [Name in keyof Values]: { readonly __value: Values[Name] } }
    : EmptyContextMap

/** Environment names are stored without the optional leading `%`. */
export type BareContextName<Name extends PropertyKey> = Name extends string
  ? Name extends `%${infer Bare}`
    ? Bare
    : Name
  : Name

/** Normalize both accepted environment-key spellings into one type-level map. */
export type NormalizeContextMap<Map> =
  Map extends Readonly<Record<PropertyKey, unknown>>
    ? { readonly [Name in keyof Map as BareContextName<Name>]: Map[Name] }
    : EmptyContextMap

/** Merge normalized maps by name, with the overlay taking precedence. */
export type MergeContextMaps<Base, Overlay> = Omit<NormalizeContextMap<Base>, keyof NormalizeContextMap<Overlay>> &
  NormalizeContextMap<Overlay>

/** Infer undeclared host values while letting explicit declarations replace them. */
export type InferredHostValueDeclarations<Values, Declarations> =
  keyof NormalizeContextMap<Values> extends keyof NormalizeContextMap<Declarations>
    ? NormalizeContextMap<Declarations>
    : MergeContextMaps<HostValueDeclarations<Values>, Declarations>

/** Read an optional context field without distributing undefined into its map. */
export type ContextProperty<Context, Name extends PropertyKey> = Name extends keyof Context
  ? Exclude<Context[Name], undefined>
  : EmptyContextMap

/** Look up one normalized name, returning never when it is undeclared. */
export type LookupContextMap<Map, Name extends string> = Name extends keyof NormalizeContextMap<Map>
  ? NormalizeContextMap<Map>[Name]
  : never
