import type { ValueKind } from '../values/type-compat.ts'

export interface StaticStateLike {
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

/** Describes whether an argument is a lambda, condition, sort key, type name, or eager value. */
export type ArgSpec = 'expression' | 'condition' | 'sort-key' | 'type-name' | 'any' | ValueKind

/**
 * The argument shapes a host function can declare. Host functions always
 * receive eagerly evaluated values (HostFunction.fn), so only the eager specs
 * are offered — declaring a lambda spec like `expression` would make the
 * analyzer check semantics the runtime does not implement.
 */
export type ValueArgSpec = 'any' | ValueKind

/**
 * Accepted focus kind, cardinality, and model types. DTO functions may set
 * `types`; built-ins must not because specification functions accept many types.
 */
export interface InputSpec {
  kind?: ValueKind
  singleton?: boolean
  /** Canonical or local model type names ('CodeableConcept', 'System.String'). */
  types?: readonly string[]
}

/**
 * The declared analyzer signature of a host-supplied function (HAPI's
 * checkFunction): what input it accepts, how its arguments are treated, and
 * what it returns. Result `types` use model or System names ('Patient',
 * 'System.String'); omitting them keeps the result an unknown region.
 */
export interface CustomFunctionSignature {
  input?: InputSpec
  args?: readonly ValueArgSpec[]
  result?: { types?: readonly string[]; single?: boolean }
}

/**
 * Declarative result rules shared by analyzer signatures and the generated
 * type-level rule table. Keeping these as data prevents the two inference
 * implementations from acquiring separate handwritten function semantics.
 */
export type ResultRule =
  | { kind: 'fixed'; types?: readonly string[]; single?: boolean }
  | { kind: 'input' }
  | { kind: 'input-item' }
  | { kind: 'argument'; index: number }
  | { kind: 'union'; sources: readonly ('input' | number)[]; single: boolean | 'all' }
  | { kind: 'arguments-union' }
  | { kind: 'reference-targets' }
  | { kind: 'unknown' }

export interface FunctionSignature {
  input?: InputSpec
  args?: readonly ArgSpec[]
  result: ResultRule
}

const BOOLEAN = { kind: 'fixed', types: ['System.Boolean'], single: true } as const satisfies ResultRule
const INTEGER = { kind: 'fixed', types: ['System.Integer'], single: true } as const satisfies ResultRule
const STRING = { kind: 'fixed', types: ['System.String'], single: true } as const satisfies ResultRule
const DECIMAL = { kind: 'fixed', types: ['System.Decimal'], single: true } as const satisfies ResultRule
const LONG = { kind: 'fixed', types: ['System.Long'], single: true } as const satisfies ResultRule
const DATE = { kind: 'fixed', types: ['System.Date'], single: true } as const satisfies ResultRule
const DATETIME = { kind: 'fixed', types: ['System.DateTime'], single: true } as const satisfies ResultRule
const TIME = { kind: 'fixed', types: ['System.Time'], single: true } as const satisfies ResultRule
const QUANTITY = { kind: 'fixed', types: ['System.Quantity'], single: true } as const satisfies ResultRule
const UNKNOWN = { kind: 'unknown' } as const satisfies ResultRule
const SAME = { kind: 'input' } as const satisfies ResultRule
const ITEM = { kind: 'input-item' } as const satisfies ResultRule

/** Interpret one declarative result rule for the runtime analyzer. */
export function applyResultRule(
  rule: ResultRule,
  input: StaticStateLike,
  args: readonly (StaticStateLike | undefined)[]
): StaticStateLike {
  switch (rule.kind) {
    case 'fixed':
      return { types: rule.types === undefined ? undefined : [...rule.types], single: rule.single }
    case 'input':
      return input
    case 'input-item':
      return withSingle(input, true)
    case 'argument': {
      const argument = args[rule.index] ?? { types: undefined, single: undefined }
      return withSingle(argument, singleAnd(input.single, argument.single))
    }
    case 'union': {
      const states = rule.sources.map(source => (source === 'input' ? input : args[source]))
      const merged = unionStates(states)
      return rule.single === 'all' ? merged : withSingle(merged, rule.single)
    }
    case 'arguments-union':
      return unionStates([...args])
    case 'reference-targets':
      return { types: input.targets, single: input.single }
    case 'unknown':
      return { types: undefined, single: undefined }
  }
}

/**
 * The input's candidate types and reference targets at a different cardinality
 * — the composition every selection/projection result goes through, so target
 * metadata survives by construction instead of by per-function special cases.
 */
export function withSingle(input: StaticStateLike, single: boolean | undefined): StaticStateLike {
  return input.targets === undefined
    ? { types: input.types, single }
    : { types: input.types, single, targets: input.targets }
}

/**
 * The union of several alternative states (iif branches, coalesce arguments,
 * merged collections): all candidate types, single only when every alternative
 * is, and reference targets preserved when every non-empty alternative
 * declares them (a statically empty side contributes nothing).
 */
export function unionStates(states: (StaticStateLike | undefined)[]): StaticStateLike {
  const present = states.filter((state): state is StaticStateLike => state !== undefined)
  const single = present.length > 0 ? present.map(state => state.single).reduce(singleAnd, true) : undefined
  const contributing = present.filter(state => state.types === undefined || state.types.length > 0)
  const targets =
    contributing.length > 0 && contributing.every(state => state.targets !== undefined)
      ? [...new Set(contributing.flatMap(state => state.targets as string[]))]
      : undefined
  const types =
    present.length === 0 || present.some(state => state.types === undefined)
      ? undefined
      : [...new Set(present.flatMap(state => state.types as string[]))]
  return targets === undefined ? { types, single } : { types, single, targets }
}

const STRING_FN = {
  input: { kind: 'String', singleton: true },
  args: ['String'],
  result: STRING,
} as const satisfies FunctionSignature
const MATH_FN = {
  input: { kind: 'Numeric', singleton: true },
  result: DECIMAL,
} as const satisfies FunctionSignature

/**
 * What the analyzer knows about each function. Functions missing here still get
 * arity checks from the runtime registry; their results become unknown.
 */
const FUNCTION_SIGNATURE_DEFINITIONS = {
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
    // The projection's analyzed state, collection-ized: single only when both
    // the input and the projection body are single.
    result: { kind: 'argument', index: 0 },
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
  union: { args: ['any'], result: { kind: 'union', sources: ['input', 0], single: false } },
  combine: { args: ['any'], result: { kind: 'union', sources: ['input', 0], single: false } },
  iif: {
    args: ['condition', 'expression', 'expression'],
    // The union of the branch states; a missing else-branch contributes empty.
    result: { kind: 'union', sources: [1, 2], single: 'all' },
  },
  // not() takes anything a Boolean test accepts (0/1, single items), so no kind pin.
  not: { input: { singleton: true }, result: BOOLEAN },
  trace: { args: ['String', 'expression'], result: SAME },
  children: { result: UNKNOWN },
  descendants: { result: UNKNOWN },
  // A reference resolves to its declared target types (Reference.targetProfile,
  // HAPI's TypeDetails.targets); an unconstrained reference stays unknown.
  resolve: { result: { kind: 'reference-targets' } },
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
    result: { kind: 'fixed', types: ['System.String'], single: false },
  },
  trim: { input: { kind: 'String', singleton: true }, result: STRING },
  split: {
    input: { kind: 'String', singleton: true },
    args: ['String'],
    result: { kind: 'fixed', types: ['System.String'], single: false },
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
  // Each iteration replaces the accumulator with the aggregator result. An
  // empty input returns init, when supplied, so both arguments can contribute.
  aggregate: { args: ['expression', 'any'], result: { kind: 'union', sources: [0, 1], single: 'all' } },
  sum: { input: { kind: 'Numeric' }, result: UNKNOWN },
  min: { input: { kind: 'Numeric' }, result: UNKNOWN },
  max: { input: { kind: 'Numeric' }, result: UNKNOWN },
  avg: { input: { kind: 'Numeric' }, result: DECIMAL },
  sort: { args: ['sort-key'], result: SAME },

  toBoolean: { input: { singleton: true }, result: BOOLEAN },
  toInteger: { input: { singleton: true }, result: INTEGER },
  toLong: { input: { singleton: true }, result: LONG },
  toDecimal: { input: { singleton: true }, result: DECIMAL },
  toString: { input: { singleton: true }, result: STRING },
  toDate: { input: { singleton: true }, result: DATE },
  toDateTime: { input: { singleton: true }, result: DATETIME },
  toTime: { input: { singleton: true }, result: TIME },
  toQuantity: {
    input: { singleton: true },
    args: ['String'],
    result: QUANTITY,
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

  now: { result: DATETIME },
  today: { result: DATE },
  timeOfDay: { result: TIME },
  yearOf: { input: { kind: 'Temporal', singleton: true }, result: INTEGER },
  monthOf: { input: { kind: 'Temporal', singleton: true }, result: INTEGER },
  dayOf: { input: { kind: 'Temporal', singleton: true }, result: INTEGER },
  hourOf: { input: { kind: 'Temporal', singleton: true }, result: INTEGER },
  minuteOf: { input: { kind: 'Temporal', singleton: true }, result: INTEGER },
  secondOf: { input: { kind: 'Temporal', singleton: true }, result: INTEGER },
  millisecondOf: { input: { kind: 'Temporal', singleton: true }, result: INTEGER },
  timezoneOffsetOf: { input: { kind: 'Temporal', singleton: true }, result: DECIMAL },
  dateOf: { input: { kind: 'Temporal', singleton: true }, result: DATE },
  timeOf: { input: { kind: 'Temporal', singleton: true }, result: TIME },
  lowBoundary: { input: { singleton: true }, args: ['Numeric'], result: UNKNOWN },
  highBoundary: { input: { singleton: true }, args: ['Numeric'], result: UNKNOWN },
  precision: { input: { singleton: true }, result: INTEGER },
  defineVariable: { args: ['String', 'expression'], result: SAME },
  // Variadic: the analyzer repeats the last arg spec for every position, so one
  // 'expression' entry covers all of coalesce's arguments. The result is the
  // first non-empty argument, hence the union of all of them.
  coalesce: { args: ['expression'], result: { kind: 'arguments-union' } },
  type: { result: UNKNOWN },
} as const satisfies Readonly<Record<string, FunctionSignature>>

export type FunctionSignatureName = keyof typeof FUNCTION_SIGNATURE_DEFINITIONS
export const FUNCTION_SIGNATURES: Readonly<Record<string, FunctionSignature>> = FUNCTION_SIGNATURE_DEFINITIONS
