import type { R4Bases, R4Elements, R4Resources, R4TypeOf } from '../r4/generated/type-maps.ts'

/**
 * Type-level FHIRPath inference for a tractable subset of the language:
 * dotted paths, indexers, choice elements by stem name, and the calls the
 * subset knows — the type-preserving identity functions (IDENTITY_RETURNS:
 * `where()`/`first()`/`distinct()`/`skip()`/…), `select()` over sub-paths,
 * `ofType()`/`as()`, and the fixed-return family (FIXED_RETURNS: existence
 * and comparison booleans, `count()`/`length()` and the other integer/decimal
 * results, the `toX()`/`convertsToX()` conversions, and the string functions).
 * `|`-unions of such terms and parenthesized groups (`(a | b).first()`) infer
 * the union of their term types, and a `%var` root enters the broad state.
 * Everything else degrades to `unknown[]` — never a type error, never a wrong type.
 * The runtime engine and the static analyzer cover the full language; this
 * layer only makes the common cases precise in plain tsc.
 *
 * The inference state is the current type name (possibly a union of names),
 * 'opaque' — the designed escape valve — or the broad `string` state (see
 * Navigate) for values that are knowably out of reach rather than misparsed.
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
 * Characters that never appear in an element or variable name: their presence
 * in a segment means an operator or literal got glued on (`name and x`,
 * `gender=gender`), and the runtime evaluates something entirely different
 * from a navigation. Such segments must degrade to 'opaque' — the broad state
 * would let a later fixed-return call claim a concrete type for what is
 * really a comparison.
 */
type GluedName<E extends string> = E extends
  | `${string} ${string}`
  | `${string}'${string}`
  | `${string}"${string}`
  | `${string}=${string}`
  | `${string}!${string}`
  | `${string}<${string}`
  | `${string}>${string}`
  | `${string}+${string}`
  | `${string}-${string}`
  | `${string}*${string}`
  | `${string}/${string}`
  | `${string}&${string}`
  | `${string}~${string}`
  | `${string},${string}`
  | `${string}|${string}`
  | `${string}%${string}`
  | `${string}$${string}`
  | `${string}@${string}`
  | `${string}(${string}`
  | `${string})${string}`
  | `${string}[${string}`
  | `${string}]${string}`
  | `${string}{${string}`
  | `${string}}${string}`
  | `${string}\\${string}`
  | `${string}\`${string}`
  ? true
  : false

/**
 * Navigate one element from a (possibly union) type name. A sane-looking but
 * unknown element gives `infer N` no candidate, so it falls back to its
 * constraint and the state widens to plain `string` — the broad state, a
 * second out-of-subset state besides 'opaque'. ResultOf maps it to
 * `unknown[]`; a fixed-return call after it keeps its concrete type, which
 * matches the runtime (an unknown element evaluates to empty, so exists() is
 * [false], count() [0], conversions []).
 *
 * Broad stays broad: an element miss on a KNOWN type is a typo signal, but a
 * miss on the broad state is unknowable — and unknowable is exactly what
 * broad means. `%report.effective` stays broad (its trailing `.toString()`
 * can still infer `string`), while the state never regains a concrete
 * element type. A glued segment (see GluedName) is not a navigation at all
 * and short-circuits to 'opaque' before either rule.
 */
type Navigate<S extends string, E extends string> = string extends S
  ? MissedElement<E, S>
  : ElementInfo<S, E> extends { t: infer N extends string }
    ? string extends N
      ? // No element matched: `infer N` fell back to its `string` constraint
        // (a real element is always a literal name).
        MissedElement<E, string>
      : N
    : 'opaque'

/**
 * An element lookup that found nothing: glued segments are misparses and go
 * 'opaque'; a sane-looking name widens to (or stays) the broad state. Only
 * misses pay the GluedName scan — real elements are never glued.
 */
type MissedElement<E extends string, Broad extends string> = GluedName<E> extends true ? 'opaque' : Broad

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

/** Push one stack entry per `(` of A (quoted spans already stripped). */
type PushOpens<A extends string, Acc extends unknown[]> = A extends `${string}(${infer R}`
  ? PushOpens<R, [...Acc, 0]>
  : Acc

/**
 * Depth-counting paren balance over a quote-stripped fragment: each `)` pops
 * an open `(` from the stack, and the fragment is balanced when every `)`
 * found one and no `(` stays open. Unlike Balanced, the nesting depth is
 * unbounded — the completeness checks need real depth because a group adds a
 * level around whatever its terms already nest.
 */
type BalancedDeep<A extends string, Open extends unknown[] = []> = A extends `${infer Head})${infer Rest}`
  ? PushOpens<Head, Open> extends [unknown, ...infer Remaining]
    ? BalancedDeep<Rest, Remaining>
    : false
  : PushOpens<A, Open> extends []
    ? true
    : false

/**
 * Whether a fragment is a complete sub-expression, so a `|` (or a group's `)`)
 * right after it is really at the top level: quotes pair up, and what remains
 * after stripping them balances with nothing left open. Backslashes and
 * backticks are declined outright, like CleanArg.
 */
type CompleteFragment<A extends string> = A extends `${string}\\${string}` | `${string}\`${string}`
  ? false
  : StripQuoted<A> extends infer Q extends string
    ? Q extends `${string}'${string}`
      ? false
      : BalancedDeep<Q>
    : false

/** Strip the leading/trailing spaces a union split leaves around its terms. */
type Trim<S extends string> = S extends ` ${infer R}` ? Trim<R> : S extends `${infer L} ` ? Trim<L> : S

/**
 * Functions whose result type is fixed regardless of input (FHIRPath §5.1,
 * §5.3, §5.5–§5.7). Every entry must be genuinely input-independent: these
 * types also apply after an unknown element (see Navigate), where the input
 * is empty at runtime. A value (not a type-only interface) so the unit test
 * can cross-check every entry against the analyzer's FUNCTION_SIGNATURES.
 * Entries whose result depends on the input (`power`, `abs`, `lowBoundary`,
 * `union`, `iif`, …) must stay out — degrading beats guessing.
 */
export const FIXED_RETURNS = {
  exists: 'boolean',
  empty: 'boolean',
  not: 'boolean',
  hasValue: 'boolean',
  count: 'integer',
  length: 'integer',
  toBoolean: 'boolean',
  convertsToBoolean: 'boolean',
  convertsToInteger: 'boolean',
  convertsToDecimal: 'boolean',
  convertsToString: 'boolean',
  convertsToDate: 'boolean',
  convertsToDateTime: 'boolean',
  convertsToTime: 'boolean',
  convertsToQuantity: 'boolean',
  toInteger: 'integer',
  toDecimal: 'decimal',
  toString: 'string',
  toDate: 'date',
  toDateTime: 'dateTime',
  toTime: 'time',
  toQuantity: 'Quantity',
  toChars: 'string',
  join: 'string',
  trim: 'string',
  upper: 'string',
  lower: 'string',
  replace: 'string',
  replaceMatches: 'string',
  substring: 'string',
  encode: 'string',
  decode: 'string',
  escape: 'string',
  unescape: 'string',
  split: 'string',
  matches: 'boolean',
  matchesFull: 'boolean',
  startsWith: 'boolean',
  endsWith: 'boolean',
  contains: 'boolean',
  subsetOf: 'boolean',
  supersetOf: 'boolean',
  isDistinct: 'boolean',
  allTrue: 'boolean',
  anyTrue: 'boolean',
  allFalse: 'boolean',
  anyFalse: 'boolean',
  all: 'boolean',
  indexOf: 'integer',
  lastIndexOf: 'integer',
  ceiling: 'integer',
  floor: 'integer',
  truncate: 'integer',
  round: 'decimal',
  sqrt: 'decimal',
  exp: 'decimal',
  ln: 'decimal',
  log: 'decimal',
} as const satisfies Record<string, keyof R4TypeOf & string>

type FixedReturns = typeof FIXED_RETURNS

/**
 * Functions that yield a subset or reordering of their input, so the input's
 * type carries through. Cross-checked against the analyzer the same way as
 * FIXED_RETURNS (their signatures preserve the input's types). `abs` is
 * excluded deliberately: it preserves the numeric kind at runtime, but the
 * analyzer declares its result unknown, and the table must not outrun it.
 */
export const IDENTITY_RETURNS = [
  'where',
  'first',
  'last',
  'single',
  'distinct',
  'tail',
  'skip',
  'take',
  'exclude',
  'intersect',
  'trace',
] as const

type IdentityFn = (typeof IDENTITY_RETURNS)[number]

/** One call segment, dispatched on the function name. */
type Call<S extends string, Fn extends string, Arg extends string> = Fn extends IdentityFn
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
        ParseExpr<Arg, S>
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
 * A segment whose parentheses contain dots (e.g. `select(name.given)`) runs
 * to the `)` that completes its argument; the `.` after that starts the next
 * segment. Scanned `).` by `).`: a candidate close inside a string literal,
 * or with parens still open, is not the close — CompleteFragment decides.
 * With no valid `).` split, the whole rest is one segment ending at its
 * final `)`.
 */
type StepAcrossParen<Expr extends string, S extends string> = ScanSegmentEnd<Expr, '', S>

type ScanSegmentEnd<
  Expr extends string,
  Acc extends string,
  S extends string,
> = Expr extends `${infer Head}).${infer Rest}`
  ? SegmentComplete<`${Acc}${Head}`> extends true
    ? ParseSegments<Rest, Step<S, `${Acc}${Head})`>>
    : ScanSegmentEnd<Rest, `${Acc}${Head}).`, S>
  : WholeParenSegment<`${Acc}${Expr}`, S>

/** Whether `Body)` is one complete call segment: its argument closes exactly there. */
type SegmentComplete<Body extends string> = `${Body})` extends `${infer _Fn}(${infer Arg})`
  ? CompleteFragment<Arg>
  : false

/** The rest of the expression is a single paren segment ending at its final `)`. */
type WholeParenSegment<Expr extends string, S extends string> = Expr extends `${infer Head})${''}`
  ? Step<S, `${Head})`>
  : 'opaque'

/**
 * One expression in a context state `S`: a `|`-union of terms, or a single
 * term. Tiered so plain dotted paths — the common case — pay two gate checks
 * and nothing else: the `|` gate skips the union scanner, and the second gate
 * skips Trim and the group/%var term forms.
 */
type ParseExpr<Expr extends string, S extends string> = Expr extends `${string}|${string}` | `(${string}` | `%${string}`
  ? ParseUnion<Expr, S>
  : Expr extends `${infer Root}.${infer Rest}`
    ? Root extends keyof R4Resources & string
      ? ParseSegments<Rest, Root>
      : ParseSegments<Expr, S>
    : Expr extends keyof R4Resources & string
      ? Expr
      : ParseSegments<Expr, S>

/**
 * Split off the leftmost top-level `|`. A candidate fragment whose quotes or
 * parens are cut mid-way (the `|` sat inside a literal or a group) is not a
 * split point: the fragment absorbs the `|` and the scan continues. With no
 * top-level `|` at all, the whole expression is one term — its own parse is
 * the validation, so no completeness gate applies here.
 */
type SplitUnion<Expr extends string, Acc extends string = ''> = Expr extends `${infer L}|${infer R}`
  ? CompleteFragment<`${Acc}${L}`> extends true
    ? { term: `${Acc}${L}`; rest: R }
    : SplitUnion<R, `${Acc}${L}|`>
  : { whole: `${Acc}${Expr}` }

/** Fold the split terms into one union state. */
type ParseUnion<Expr extends string, S extends string> =
  SplitUnion<Expr> extends { term: infer T extends string; rest: infer R extends string }
    ? UnionStates<ParseTerm<Trim<T>, S>, ParseUnion<R, S>>
    : SplitUnion<Expr> extends { whole: infer W extends string }
      ? ParseTerm<Trim<W>, S>
      : 'opaque'

/**
 * The union of two term states. If EITHER side failed to parse, the whole
 * union is 'opaque' — a known name must never absorb a failed parse. A broad
 * member needs no special case: `string` swallows the other names, and
 * unknowable-joined-with-anything is unknowable.
 */
type UnionStates<A extends string, B extends string> = [A] extends ['opaque']
  ? 'opaque'
  : [B] extends ['opaque']
    ? 'opaque'
    : A | B

/**
 * One union term (or a whole single-term expression): a parenthesized group,
 * a `%var` root, a resource-rooted path, or a path relative to the context
 * state `S`. The top level passes S = 'opaque', so relative terms degrade
 * there; select() passes its input state, so its sub-paths resolve.
 */
type ParseTerm<Term extends string, S extends string> = Term extends `(${infer Body}`
  ? ExtractGroup<Body, '', S>
  : Term extends `%${infer Var}`
    ? ParseVarTerm<Var>
    : Term extends `${infer Root}.${infer Rest}`
      ? Root extends keyof R4Resources & string
        ? ParseSegments<Rest, Root>
        : ParseSegments<Term, S>
      : Term extends keyof R4Resources & string
        ? Term
        : ParseSegments<Term, S>

/**
 * A `%var` root enters the broad state: the variable's value is unknowable
 * here, and broad is exactly "unknowable" — plain navigation stays
 * `unknown[]`, while a fixed-return call (`%rowIndex.toString()`) keeps its
 * input-independent type. The name must look like a name: a glued operator
 * (`%a = b`) would make the runtime evaluate a comparison, not a variable.
 */
type ParseVarTerm<Var extends string> = Var extends `${infer Name}.${infer Rest}`
  ? GluedName<Name> extends true
    ? 'opaque'
    : ParseSegments<Rest, string>
  : GluedName<Var> extends true
    ? 'opaque'
    : string

/**
 * Find the `)` closing a group's opening paren: scan `)` by `)`, and the
 * first one whose interior is a complete fragment closes the group. What
 * follows must be nothing or a `.`-chain — anything else (`(A | B) = (C)`)
 * is a glued operator.
 */
type ExtractGroup<Body extends string, Acc extends string, S extends string> = Body extends `${infer L})${infer R}`
  ? CompleteFragment<`${Acc}${L}`> extends true
    ? GroupTail<ParseExpr<`${Acc}${L}`, S>, R>
    : ExtractGroup<R, `${Acc}${L})`, S>
  : 'opaque'

/** Continue after a group: `(…)` ends the term, `(…).rest` walks on from the group's state. */
type GroupTail<G extends string, Tail extends string> = Tail extends ''
  ? G
  : Tail extends `.${infer Rest}`
    ? ParseSegments<Rest, G>
    : 'opaque'

/** The unwrapped result element type for a state; `[…]` keeps unions whole. */
type ResultOf<S extends string> = [S] extends [keyof R4TypeOf] ? R4TypeOf[S][] : unknown[]

/**
 * The inferred result of evaluating `Expr` against its root resource.
 * `string` (a non-literal expression) and anything outside the subset give
 * `unknown[]`. The top-level context is 'opaque': terms must be resource-
 * rooted, `%var`-rooted, or parenthesized groups of those — a relative term
 * (`id | …`) has no root to resolve against here and degrades.
 */
export type FhirpathResult<Expr extends string> = string extends Expr ? unknown[] : ResultOf<ParseExpr<Expr, 'opaque'>>

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
