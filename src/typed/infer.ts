import type { R4Bases, R4Elements, R4Resources, R4TypeOf } from '../r4/generated/type-maps.ts'

/**
 * Type-level FHIRPath inference for a tractable subset of the language:
 * dotted paths, indexers, choice elements by stem name, and the calls the
 * subset knows — type-preserving `where()`/`first()`/`last()`/`single()`,
 * `select()` over sub-paths, `ofType()`/`as()`, and the fixed-return family
 * (`exists()`/`empty()`/`not()`/`hasValue()`, `count()`/`length()`, the
 * `toX()`/`convertsToX()` conversions, `join()`, `toChars()`). Everything
 * else degrades to `unknown[]` — never a type error, never a wrong type.
 * The runtime engine and the static analyzer cover the full language; this
 * layer only makes the common cases precise in plain tsc.
 *
 * The inference state is the current type name (possibly a union of names),
 * or 'opaque' — the designed escape valve.
 */

/** Element lookup by name, walking base types. */
type ElementInfo<T extends string, E extends string> = T extends keyof R4Elements
  ? E extends keyof R4Elements[T]
    ? R4Elements[T][E]
    : T extends keyof R4Bases
      ? R4Bases[T] extends string
        ? ElementInfo<R4Bases[T], E>
        : never
      : never
  : never

/**
 * Navigate one element from a (possibly union) type name. An unknown element
 * gives `infer N` no candidate, so it falls back to its constraint and the
 * state widens to plain `string` — a second out-of-subset state besides
 * 'opaque'. ResultOf maps it to `unknown[]`; a fixed-return call after it
 * keeps its concrete type, which matches the runtime (an unknown element
 * evaluates to empty, so exists() is [false], count() [0], conversions []).
 */
type Navigate<S extends string, E extends string> =
  ElementInfo<S, E> extends { t: infer N extends string } ? N : 'opaque'

/**
 * Whether a matched function argument really closes at the segment's final
 * `)`. String literals are stripped first so parens inside them don't count;
 * in what remains, a `)` with no `(` still open is the signature of an
 * operator glued onto the call — `join(', ') = ('x')` matches
 * `join(${string})` with the "argument" `', ') = ('x'`, but the runtime sees
 * a comparison. Arguments containing backslashes or backticks are declined
 * outright: escape sequences and delimited identifiers can confound the
 * quote pairing that stripping relies on.
 */
type CleanArg<A extends string> = A extends `${string}\\${string}` | `${string}\`${string}`
  ? false
  : Balanced<StripQuoted<A>>

/** Removes `'…'` spans so parens inside string literals don't disturb Balanced. */
type StripQuoted<A extends string> = A extends `${infer L}'${string}'${infer R}` ? `${L}${StripQuoted<R>}` : A

/** Every `(` opens before its `)` closes; one nesting level per pair. */
type Balanced<A extends string> = A extends `${infer L}(${infer M})${infer R}`
  ? L extends `${string})${string}`
    ? false
    : M extends `${string}(${string}`
      ? false
      : Balanced<R>
  : A extends `${string})${string}`
    ? false
    : true

/**
 * Functions whose result type is fixed regardless of input (FHIRPath §5.1,
 * §5.5, §5.7). Every entry must be genuinely input-independent: these types
 * also apply after an unknown element (see Navigate), where the input is
 * empty at runtime.
 */
interface FixedReturns {
  exists: 'boolean'
  empty: 'boolean'
  not: 'boolean'
  hasValue: 'boolean'
  count: 'integer'
  length: 'integer'
  toBoolean: 'boolean'
  convertsToBoolean: 'boolean'
  convertsToInteger: 'boolean'
  convertsToDecimal: 'boolean'
  convertsToString: 'boolean'
  convertsToDate: 'boolean'
  convertsToDateTime: 'boolean'
  convertsToTime: 'boolean'
  convertsToQuantity: 'boolean'
  toInteger: 'integer'
  toDecimal: 'decimal'
  toString: 'string'
  toDate: 'date'
  toDateTime: 'dateTime'
  toTime: 'time'
  toQuantity: 'Quantity'
  toChars: 'string'
  join: 'string'
}

/** One call segment, dispatched on the function name. */
type Call<S extends string, Fn extends string, Arg extends string> = Fn extends 'where' | 'first' | 'last' | 'single'
  ? S
  : Fn extends 'ofType' | 'as'
    ? Arg extends keyof R4TypeOf & string
      ? Arg
      : 'opaque'
    : Fn extends keyof FixedReturns
      ? FixedReturns[Fn]
      : 'opaque'

/** One `.`-separated segment: a call the subset knows, an indexer, or an element. */
type Step<S extends string, Seg extends string> = [S] extends ['opaque']
  ? 'opaque'
  : Seg extends `${infer Fn}(${infer Arg})`
    ? Fn extends 'select'
      ? // select's argument is a sub-expression: parsing it is the guard.
        ParseSegments<Arg, S>
      : CleanArg<Arg> extends true
        ? Call<S, Fn, Arg>
        : 'opaque'
    : Seg extends `${infer N}[${infer I}]`
      ? I extends `${string}]${string}` | `${string}[${string}`
        ? // A ']' or '[' inside the index means this "one indexer" spans an
          // operator (`family[0] | active[0]`): outside the subset.
          'opaque'
        : Navigate<S, N>
      : Navigate<S, Seg>

/** Walk the remaining `.`-separated segments. */
type ParseSegments<Expr extends string, S extends string> = Expr extends ''
  ? S
  : Expr extends `${infer Head}.${infer Rest}`
    ? Head extends `${string}(` | `${string}(${string}`
      ? // A '.' inside parentheses split the segment: rejoin before stepping.
        StepAcrossParen<Expr, S>
      : ParseSegments<Rest, Step<S, Head>>
    : Step<S, Expr>

/**
 * A segment whose parentheses contain dots (e.g. `select(name.given)`) needs the
 * matching close before the next real segment; one nesting level is supported.
 * The first `).` closes the segment when only one `(` opened before it; with a
 * second `(` open, that close is nested and the segment runs to the final `)`.
 */
type StepAcrossParen<Expr extends string, S extends string> = Expr extends `${infer Head}).${infer Rest}`
  ? Head extends `${string})${string}`
    ? 'opaque'
    : Head extends `${string}(${string}(${string}`
      ? WholeParenSegment<Expr, S>
      : ParseSegments<Rest, Step<S, `${Head})`>>
  : WholeParenSegment<Expr, S>

/** The rest of the expression is a single paren segment ending at its final `)`. */
type WholeParenSegment<Expr extends string, S extends string> = Expr extends `${infer Head})${''}`
  ? Step<S, `${Head})`>
  : 'opaque'

/** The root segment names the resource type. */
type ParseRoot<Expr extends string> = Expr extends `${infer Root}.${infer Rest}`
  ? Root extends keyof R4Resources & string
    ? ParseSegments<Rest, Root>
    : 'opaque'
  : Expr extends keyof R4Resources & string
    ? Expr
    : 'opaque'

/** The unwrapped result element type for a state; `[…]` keeps unions whole. */
type ResultOf<S extends string> = [S] extends [keyof R4TypeOf] ? R4TypeOf[S][] : unknown[]

/**
 * The inferred result of evaluating `Expr` against its root resource.
 * `string` (a non-literal expression) and anything outside the subset give `unknown[]`.
 */
export type FhirpathResult<Expr extends string> = string extends Expr ? unknown[] : ResultOf<ParseRoot<Expr>>

/** The expected input resource for `Expr` (`Patient.name` wants a Patient). */
export type FhirpathInput<Expr extends string> = string extends Expr
  ? unknown
  : Expr extends `${infer Root}.${string}`
    ? Root extends keyof R4Resources
      ? R4Resources[Root]
      : unknown
    : Expr extends keyof R4Resources
      ? R4Resources[Expr]
      : unknown
