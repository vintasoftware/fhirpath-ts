/** An empty host context that contributes no known keys. */
export type EmptyContextMap = Record<never, never>

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

/** Read an optional context field without distributing undefined into its map. */
export type ContextProperty<Context, Name extends PropertyKey> = Name extends keyof Context
  ? Exclude<Context[Name], undefined>
  : EmptyContextMap

/** Look up one normalized name, returning never when it is undeclared. */
export type LookupContextMap<Map, Name extends string> = Name extends keyof NormalizeContextMap<Map>
  ? NormalizeContextMap<Map>[Name]
  : never
