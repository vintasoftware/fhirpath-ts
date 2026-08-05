import type { R4Bases, R4Elements, R4Resources, R4TypeOf } from '../r4/generated/type-maps.ts'

/**
 * Type-level FHIRPath inference for a tractable subset of the language:
 * dotted paths, indexers, first()/last()/single(), type-preserving where(),
 * select() over sub-paths, ofType(), exists()/empty()/count()/not()/hasValue(),
 * the fixed-return conversion family (toBoolean()/toInteger()/…/toQuantity()
 * and their convertsToX() tests), join(), toChars(), and choice elements by
 * stem name. Everything else degrades to `unknown[]` — never a type error.
 * The runtime engine and the static analyzer cover the full language; this
 * layer only makes the common cases precise in plain tsc.
 */

/** Inference state: the current type name(s) — or opaque, the designed escape valve. */
interface State {
  n: string
  many: boolean
}

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

/** Navigate one element from a (possibly union) type name. */
type Navigate<S extends State, E extends string> =
  ElementInfo<S['n'], E> extends { t: infer N extends string; a: infer A extends boolean }
    ? { n: N; many: S['many'] extends true ? true : A }
    : 'opaque'

type StripCount<S extends string> = S extends `${infer N}[${string}]` ? N : S

/**
 * Whether a matched function argument really closes at the segment's final
 * `)`. A `)` with no `(` still open is the signature of an operator glued
 * onto the call — `join(', ') = ('x')` matches `join(${string})` with the
 * "argument" `', ') = ('x'`, but the runtime sees a comparison. One nesting
 * level inside the argument (`where(given.first() = 'P')`) is accepted.
 */
type CleanArg<A extends string> = A extends `${infer L}(${infer M})${infer R}`
  ? L extends `${string})${string}`
    ? false
    : M extends `${string}(${string}`
      ? false
      : CleanArg<R>
  : A extends `${string})${string}`
    ? false
    : true

/**
 * Segments that always yield a boolean singleton: toBoolean() and the
 * no-argument conversion tests (FHIRPath §5.5). `convertsToQuantity(unit)`
 * has its own branch so its argument goes through CleanArg.
 */
type BooleanConversionSeg =
  | 'toBoolean()'
  | 'convertsToBoolean()'
  | 'convertsToInteger()'
  | 'convertsToDecimal()'
  | 'convertsToString()'
  | 'convertsToDate()'
  | 'convertsToDateTime()'
  | 'convertsToTime()'

/** The remaining no-argument §5.5 conversions, keyed by segment → result type name. */
interface ConversionReturns {
  'toInteger()': 'integer'
  'toDecimal()': 'decimal'
  'toString()': 'string'
  'toDate()': 'date'
  'toDateTime()': 'dateTime'
  'toTime()': 'time'
}

/** One `.`-separated segment: a function the subset knows, an indexer, or an element. */
type Step<S extends State | 'opaque', Seg extends string> = S extends State
  ? Seg extends `where(${infer Cond})`
    ? CleanArg<Cond> extends true
      ? S
      : 'opaque'
    : Seg extends `ofType(${infer T})` | `as(${infer T})`
      ? T extends keyof R4TypeOf & string
        ? { n: T; many: S['many'] }
        : 'opaque'
      : Seg extends 'first()' | 'last()' | 'single()'
        ? { n: S['n']; many: false }
        : Seg extends 'exists()' | 'empty()' | 'not()' | 'hasValue()'
          ? { n: 'boolean'; many: false }
          : Seg extends 'count()' | 'length()'
            ? { n: 'integer'; many: false }
            : Seg extends `select(${infer Inner})`
              ? ParseSegments<Inner, { n: S['n']; many: false }> extends infer Projected
                ? Projected extends State
                  ? { n: Projected['n']; many: true }
                  : 'opaque'
                : 'opaque'
              : Seg extends BooleanConversionSeg
                ? { n: 'boolean'; many: false }
                : Seg extends keyof ConversionReturns
                  ? { n: ConversionReturns[Seg]; many: false }
                  : Seg extends `convertsToQuantity(${infer Unit})`
                    ? CleanArg<Unit> extends true
                      ? { n: 'boolean'; many: false }
                      : 'opaque'
                    : Seg extends `toQuantity(${infer Unit})`
                      ? CleanArg<Unit> extends true
                        ? { n: 'Quantity'; many: false }
                        : 'opaque'
                      : Seg extends `join(${infer Sep})`
                        ? CleanArg<Sep> extends true
                          ? { n: 'string'; many: false }
                          : 'opaque'
                        : Seg extends 'toChars()'
                          ? { n: 'string'; many: true }
                          : Seg extends `${string}(${string})` | `${string}()`
                            ? 'opaque'
                            : Seg extends `${infer N}[${infer I}]`
                              ? I extends `${string}]${string}` | `${string}[${string}`
                                ? // A ']' or '[' inside the index means this "one indexer"
                                  // spans an operator (`family[0] | active[0]`): outside the subset.
                                  'opaque'
                                : Navigate<S, StripCount<N>> extends infer Indexed
                                  ? Indexed extends State
                                    ? { n: Indexed['n']; many: false }
                                    : 'opaque'
                                  : 'opaque'
                              : Navigate<S, Seg>
  : 'opaque'

/** Walk the remaining `.`-separated segments. */
type ParseSegments<Expr extends string, S extends State | 'opaque'> = Expr extends ''
  ? S
  : Expr extends `${infer Head}.${infer Rest}`
    ? Head extends `${string}(` | `${string}(${string}`
      ? // A '.' inside parentheses split the segment: outside the subset.
        StepAcrossParen<Expr, S>
      : ParseSegments<Rest, Step<S, Head>>
    : Step<S, Expr>

/**
 * A segment whose parentheses contain dots (e.g. `select(name.given)`) needs the
 * matching close before the next real segment; one nesting level is supported.
 * The first `).` closes the segment when only one `(` opened before it; with a
 * second `(` open, that close is nested and the segment runs to the final `)`.
 */
type StepAcrossParen<Expr extends string, S extends State | 'opaque'> = Expr extends `${infer Head}).${infer Rest}`
  ? Head extends `${string})${string}`
    ? 'opaque'
    : Head extends `${string}(${string}(${string}`
      ? WholeParenSegment<Expr, S>
      : ParseSegments<Rest, Step<S, `${Head})`>>
  : WholeParenSegment<Expr, S>

/** The rest of the expression is a single paren segment ending at its final `)`. */
type WholeParenSegment<Expr extends string, S extends State | 'opaque'> = Expr extends `${infer Head})${''}`
  ? Step<S, `${Head})`>
  : 'opaque'

/** The root segment names the resource type. */
type ParseRoot<Expr extends string> = Expr extends `${infer Root}.${infer Rest}`
  ? Root extends keyof R4Resources & string
    ? ParseSegments<Rest, { n: Root; many: false }>
    : 'opaque'
  : Expr extends keyof R4Resources & string
    ? { n: Expr; many: false }
    : 'opaque'

/** The unwrapped result element type for a state. */
type ResultOf<S extends State | 'opaque'> = S extends State
  ? S['n'] extends keyof R4TypeOf
    ? R4TypeOf[S['n']][]
    : unknown[]
  : unknown[]

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
