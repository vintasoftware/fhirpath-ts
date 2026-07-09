import { FHIR_PRIMITIVE_TO_SYSTEM, typeLocalName } from '../values/typed-value.ts'

/** Behavior families used by the static checks. */
export type ValueKind = 'Boolean' | 'String' | 'Numeric' | 'Temporal' | 'Quantity' | 'Complex'

export function valueKindOfTypeName(canonical: string): ValueKind {
  const system = canonical.startsWith('System.') ? canonical : FHIR_PRIMITIVE_TO_SYSTEM[typeLocalName(canonical)]
  switch (system) {
    case 'System.Boolean':
      return 'Boolean'
    case 'System.String':
      return 'String'
    case 'System.Integer':
    case 'System.Long':
    case 'System.Decimal':
      return 'Numeric'
    case 'System.Date':
    case 'System.DateTime':
    case 'System.Time':
      return 'Temporal'
    case 'System.Quantity':
      return 'Quantity'
    default:
      return canonical === 'FHIR.Quantity' || typeLocalName(canonical) === 'Quantity' ? 'Quantity' : 'Complex'
  }
}

interface StaticStateLike {
  types: string[] | undefined
  /** True: at most one item. False: may hold several. Undefined: cardinality unknown. */
  single: boolean | undefined
  /** Canonical resource types a Reference state may point to — resolve()'s result. */
  targets?: string[]
}

/** Cardinality of a value combined from two parts: single only when both are. */
export function singleAnd(a: boolean | undefined, b: boolean | undefined): boolean | undefined {
  if (a === false || b === false) {
    return false
  }
  return a === true && b === true ? true : undefined
}

/**
 * How the analyzer treats one argument position:
 * - `expression`: a lambda evaluated per item ($this bound); its analyzed state
 *   is captured for the `result` callback.
 * - `condition`: an `expression` that must be a single Boolean (iif's criterion).
 * - `sort-key`: an `expression` where a top-level unary `-` marks descending
 *   order on any type, mirroring sort()'s runtime reading of the AST.
 * - `type-name`: a type specifier, checked against the model.
 * - `any` / a ValueKind: a value argument, optionally kind-checked.
 */
export type ArgSpec = 'expression' | 'condition' | 'sort-key' | 'type-name' | 'any' | ValueKind

/**
 * The declarative static-typing leg of a host-supplied function (HAPI's
 * checkFunction): what input it accepts, how its arguments are treated, and
 * what it returns. Result `types` use model or System names ('Patient',
 * 'System.String'); omitting them keeps the result an unknown region.
 */
export interface CustomFunctionSignature {
  input?: { kind?: ValueKind; singleton?: boolean }
  args?: ArgSpec[]
  result?: { types?: string[]; single?: boolean }
}

export interface FunctionSignature {
  input?: { kind?: ValueKind; singleton?: boolean }
  args?: ArgSpec[]
  /**
   * Result state from the input state and the analyzed argument states
   * (undefined for `type-name` positions and missing optional arguments).
   */
  result: (input: StaticStateLike, args: readonly (StaticStateLike | undefined)[]) => StaticStateLike
}

const BOOLEAN = (): StaticStateLike => ({ types: ['System.Boolean'], single: true })
const INTEGER = (): StaticStateLike => ({ types: ['System.Integer'], single: true })
const STRING = (): StaticStateLike => ({ types: ['System.String'], single: true })
const DECIMAL = (): StaticStateLike => ({ types: ['System.Decimal'], single: true })
const UNKNOWN = (): StaticStateLike => ({ types: undefined, single: undefined })
const SAME = (input: StaticStateLike): StaticStateLike => input
// Reference targets survive item selection so `subject.first().resolve()` stays typed.
const ITEM = (input: StaticStateLike): StaticStateLike =>
  input.targets === undefined
    ? { types: input.types, single: true }
    : { types: input.types, single: true, targets: input.targets }
/**
 * The union of several alternative states (iif branches, coalesce arguments):
 * all candidate types, single only when every alternative is.
 */
function unionOf(states: (StaticStateLike | undefined)[]): StaticStateLike {
  const present = states.filter((state): state is StaticStateLike => state !== undefined)
  const single = present.length > 0 ? present.map(state => state.single).reduce(singleAnd, true) : undefined
  if (present.length === 0 || present.some(state => state.types === undefined)) {
    return { types: undefined, single }
  }
  return {
    types: [...new Set(present.flatMap(state => state.types as string[]))],
    single,
  }
}

const STRING_FN: FunctionSignature = { input: { kind: 'String', singleton: true }, args: ['String'], result: STRING }
const MATH_FN: FunctionSignature = { input: { kind: 'Numeric', singleton: true }, result: DECIMAL }

/**
 * What the analyzer knows about each function. Functions missing here still get
 * arity checks from the runtime registry; their results become unknown.
 */
export const FUNCTION_SIGNATURES: Readonly<Record<string, FunctionSignature>> = {
  empty: { result: BOOLEAN },
  exists: { args: ['expression'], result: BOOLEAN },
  all: { args: ['expression'], result: BOOLEAN },
  allTrue: { input: { kind: 'Boolean' }, result: BOOLEAN },
  anyTrue: { input: { kind: 'Boolean' }, result: BOOLEAN },
  allFalse: { input: { kind: 'Boolean' }, result: BOOLEAN },
  anyFalse: { input: { kind: 'Boolean' }, result: BOOLEAN },
  count: { result: INTEGER },
  distinct: { result: SAME },
  isDistinct: { result: BOOLEAN },
  subsetOf: { args: ['any'], result: BOOLEAN },
  supersetOf: { args: ['any'], result: BOOLEAN },
  // Filters cannot grow their input, so cardinality is preserved: filtering a
  // single item yields at most one item.
  where: { args: ['expression'], result: SAME },
  select: {
    args: ['expression'],
    // The projection's analyzed type, collection-ized: single only when both the
    // input and the projection body are single (Samurai's Lambda<R, Single<T>> → R).
    result: (input, args) => ({
      types: args[0]?.types,
      single: singleAnd(input.single, args[0]?.single),
    }),
  },
  repeat: { args: ['expression'], result: UNKNOWN },
  // ofType/as results narrow to the named type; the analyzer computes that with
  // the model (walkCall), so their table results are never consulted.
  ofType: { args: ['type-name'], result: UNKNOWN },
  is: { input: { singleton: true }, args: ['type-name'], result: BOOLEAN },
  as: { input: { singleton: true }, args: ['type-name'], result: UNKNOWN },
  single: { result: ITEM },
  first: { result: ITEM },
  last: { result: ITEM },
  tail: { result: SAME },
  skip: { args: ['Numeric'], result: SAME },
  take: { args: ['Numeric'], result: SAME },
  intersect: { args: ['any'], result: SAME },
  exclude: { args: ['any'], result: SAME },
  union: { args: ['any'], result: (input, args) => ({ types: unionOf([input, args[0]]).types, single: false }) },
  combine: { args: ['any'], result: (input, args) => ({ types: unionOf([input, args[0]]).types, single: false }) },
  iif: {
    args: ['condition', 'expression', 'expression'],
    // The union of the branch types; a missing else-branch contributes empty.
    result: (_input, args) => unionOf([args[1], args[2] ?? { types: [], single: true }]),
  },
  // not() takes anything a Boolean test accepts (0/1, single items), so no kind pin.
  not: { input: { singleton: true }, result: BOOLEAN },
  trace: { args: ['String', 'expression'], result: SAME },
  children: { result: UNKNOWN },
  descendants: { result: UNKNOWN },
  // A reference resolves to its declared target types (Reference.targetProfile,
  // HAPI's TypeDetails.targets); an unconstrained reference stays unknown.
  resolve: { result: input => ({ types: input.targets, single: input.single }) },
  extension: { args: ['String'], result: UNKNOWN },
  hasValue: { input: { singleton: true }, result: BOOLEAN },
  getValue: { input: { singleton: true }, result: UNKNOWN },
  htmlChecks: { input: { singleton: true }, result: BOOLEAN },
  comparable: { input: { kind: 'Quantity', singleton: true }, args: ['Quantity'], result: BOOLEAN },
  conformsTo: { input: { singleton: true }, args: ['String'], result: BOOLEAN },

  length: { input: { kind: 'String', singleton: true }, result: INTEGER },
  indexOf: { ...STRING_FN, result: INTEGER },
  lastIndexOf: { ...STRING_FN, result: INTEGER },
  substring: { input: { kind: 'String', singleton: true }, args: ['Numeric', 'Numeric'], result: STRING },
  startsWith: { ...STRING_FN, result: BOOLEAN },
  endsWith: { ...STRING_FN, result: BOOLEAN },
  contains: { ...STRING_FN, result: BOOLEAN },
  upper: { input: { kind: 'String', singleton: true }, result: STRING },
  lower: { input: { kind: 'String', singleton: true }, result: STRING },
  replace: { input: { kind: 'String', singleton: true }, args: ['String', 'String'], result: STRING },
  matches: { ...STRING_FN, result: BOOLEAN },
  matchesFull: { ...STRING_FN, result: BOOLEAN },
  replaceMatches: { input: { kind: 'String', singleton: true }, args: ['String', 'String'], result: STRING },
  toChars: {
    input: { kind: 'String', singleton: true },
    result: () => ({ types: ['System.String'], single: false }),
  },
  trim: { input: { kind: 'String', singleton: true }, result: STRING },
  split: {
    input: { kind: 'String', singleton: true },
    args: ['String'],
    result: () => ({ types: ['System.String'], single: false }),
  },
  join: { input: { kind: 'String' }, args: ['String'], result: STRING },
  encode: STRING_FN,
  decode: STRING_FN,
  escape: STRING_FN,
  unescape: STRING_FN,

  abs: { input: { singleton: true }, result: UNKNOWN },
  ceiling: { input: { kind: 'Numeric', singleton: true }, result: INTEGER },
  floor: { input: { kind: 'Numeric', singleton: true }, result: INTEGER },
  truncate: { input: { kind: 'Numeric', singleton: true }, result: INTEGER },
  round: { input: { kind: 'Numeric', singleton: true }, args: ['Numeric'], result: DECIMAL },
  exp: MATH_FN,
  ln: MATH_FN,
  sqrt: MATH_FN,
  log: { input: { kind: 'Numeric', singleton: true }, args: ['Numeric'], result: DECIMAL },
  power: { input: { kind: 'Numeric', singleton: true }, args: ['Numeric'], result: UNKNOWN },
  aggregate: { args: ['expression', 'any'], result: UNKNOWN },
  sum: { input: { kind: 'Numeric' }, result: UNKNOWN },
  min: { input: { kind: 'Numeric' }, result: UNKNOWN },
  max: { input: { kind: 'Numeric' }, result: UNKNOWN },
  avg: { input: { kind: 'Numeric' }, result: DECIMAL },
  sort: { args: ['sort-key'], result: SAME },

  toBoolean: { input: { singleton: true }, result: BOOLEAN },
  toInteger: { input: { singleton: true }, result: INTEGER },
  toLong: { input: { singleton: true }, result: () => ({ types: ['System.Long'], single: true }) },
  toDecimal: { input: { singleton: true }, result: DECIMAL },
  toString: { input: { singleton: true }, result: STRING },
  toDate: { input: { singleton: true }, result: () => ({ types: ['System.Date'], single: true }) },
  toDateTime: { input: { singleton: true }, result: () => ({ types: ['System.DateTime'], single: true }) },
  toTime: { input: { singleton: true }, result: () => ({ types: ['System.Time'], single: true }) },
  toQuantity: {
    input: { singleton: true },
    args: ['String'],
    result: () => ({ types: ['System.Quantity'], single: true }),
  },
  convertsToBoolean: { input: { singleton: true }, result: BOOLEAN },
  convertsToInteger: { input: { singleton: true }, result: BOOLEAN },
  convertsToLong: { input: { singleton: true }, result: BOOLEAN },
  convertsToDecimal: { input: { singleton: true }, result: BOOLEAN },
  convertsToString: { input: { singleton: true }, result: BOOLEAN },
  convertsToDate: { input: { singleton: true }, result: BOOLEAN },
  convertsToDateTime: { input: { singleton: true }, result: BOOLEAN },
  convertsToTime: { input: { singleton: true }, result: BOOLEAN },
  convertsToQuantity: { input: { singleton: true }, args: ['String'], result: BOOLEAN },

  now: { result: () => ({ types: ['System.DateTime'], single: true }) },
  today: { result: () => ({ types: ['System.Date'], single: true }) },
  timeOfDay: { result: () => ({ types: ['System.Time'], single: true }) },
  yearOf: { input: { kind: 'Temporal', singleton: true }, result: INTEGER },
  monthOf: { input: { kind: 'Temporal', singleton: true }, result: INTEGER },
  dayOf: { input: { kind: 'Temporal', singleton: true }, result: INTEGER },
  hourOf: { input: { kind: 'Temporal', singleton: true }, result: INTEGER },
  minuteOf: { input: { kind: 'Temporal', singleton: true }, result: INTEGER },
  secondOf: { input: { kind: 'Temporal', singleton: true }, result: INTEGER },
  millisecondOf: { input: { kind: 'Temporal', singleton: true }, result: INTEGER },
  timezoneOffsetOf: { input: { kind: 'Temporal', singleton: true }, result: DECIMAL },
  dateOf: { input: { kind: 'Temporal', singleton: true }, result: () => ({ types: ['System.Date'], single: true }) },
  timeOf: { input: { kind: 'Temporal', singleton: true }, result: () => ({ types: ['System.Time'], single: true }) },
  lowBoundary: { input: { singleton: true }, args: ['Numeric'], result: UNKNOWN },
  highBoundary: { input: { singleton: true }, args: ['Numeric'], result: UNKNOWN },
  precision: { input: { singleton: true }, result: INTEGER },
  defineVariable: { args: ['String', 'expression'], result: SAME },
  // Variadic: the analyzer repeats the last arg spec for every position, so one
  // 'expression' entry covers all of coalesce's arguments. The result is the
  // first non-empty argument, hence the union of all of them.
  coalesce: { args: ['expression'], result: (_input, args) => unionOf([...args]) },
  type: { result: UNKNOWN },
}
