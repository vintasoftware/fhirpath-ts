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
  single: boolean
}

type ArgSpec = 'expression' | 'type-name' | 'any' | ValueKind

export interface FunctionSignature {
  input?: { kind?: ValueKind; singleton?: boolean }
  args?: ArgSpec[]
  result: (input: StaticStateLike) => StaticStateLike
}

const BOOLEAN = (): StaticStateLike => ({ types: ['System.Boolean'], single: true })
const INTEGER = (): StaticStateLike => ({ types: ['System.Integer'], single: true })
const STRING = (): StaticStateLike => ({ types: ['System.String'], single: true })
const DECIMAL = (): StaticStateLike => ({ types: ['System.Decimal'], single: true })
const UNKNOWN = (): StaticStateLike => ({ types: undefined, single: false })
const SAME = (input: StaticStateLike): StaticStateLike => input
const ITEM = (input: StaticStateLike): StaticStateLike => ({ types: input.types, single: true })
const COLLECTION = (input: StaticStateLike): StaticStateLike => ({ types: input.types, single: false })

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
  where: { args: ['expression'], result: COLLECTION },
  select: { args: ['expression'], result: UNKNOWN },
  repeat: { args: ['expression'], result: UNKNOWN },
  ofType: { args: ['type-name'], result: UNKNOWN },
  is: { input: { singleton: true }, args: ['type-name'], result: BOOLEAN },
  as: { input: { singleton: true }, args: ['type-name'], result: UNKNOWN },
  single: { result: ITEM },
  first: { result: ITEM },
  last: { result: ITEM },
  tail: { result: COLLECTION },
  skip: { args: ['Numeric'], result: COLLECTION },
  take: { args: ['Numeric'], result: COLLECTION },
  intersect: { args: ['any'], result: COLLECTION },
  exclude: { args: ['any'], result: COLLECTION },
  union: { args: ['any'], result: UNKNOWN },
  combine: { args: ['any'], result: UNKNOWN },
  iif: { args: ['expression', 'expression', 'expression'], result: UNKNOWN },
  not: { input: { kind: 'Boolean', singleton: true }, result: BOOLEAN },
  trace: { args: ['String', 'expression'], result: SAME },
  children: { result: UNKNOWN },
  descendants: { result: UNKNOWN },
  resolve: { result: UNKNOWN },
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
  sort: { args: ['expression'], result: SAME },

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
  coalesce: { args: ['expression', 'expression', 'expression', 'expression'], result: UNKNOWN },
  type: { result: UNKNOWN },
}
