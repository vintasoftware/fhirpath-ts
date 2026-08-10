import type { R4Resources, R4TypeOf } from '../r4/generated/type-maps.ts'
import type { InferTypeExpression } from './parser.ts'

/** A type name known by the generated R4 model. */
export type FhirTypeName = keyof R4TypeOf & string

/**
 * Functions with input-independent result types supported by the original
 * inference subset. The full generated result-rule interpreter replaces this
 * compatibility list in the function phase.
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
  toQuantity: 'System.Quantity',
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
} as const satisfies Record<string, FhirTypeName>

type FixedFunction = keyof typeof FIXED_RETURNS

/** Functions whose original inference rule preserved the input element type. */
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

type IdentityFunction = (typeof IDENTITY_RETURNS)[number]

/** The inferred result of evaluating a literal FHIRPath expression. */
export type FhirpathResult<Expression extends string> = FhirpathResultIn<Expression, 'opaque'>

/**
 * The inferred result with an explicit FHIR input type. Non-literal,
 * malformed, over-budget, or unsupported expressions safely become
 * `unknown[]`.
 */
export type FhirpathResultIn<Expression extends string, Input extends string> = string extends Expression
  ? unknown[]
  : InferTypeExpression<Expression, Input, FixedFunction, IdentityFunction>

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
