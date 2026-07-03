import type { SourceSpan } from '../errors.ts'

export type TokenKind =
  | 'identifier'
  | 'delimitedIdentifier'
  | 'string'
  | 'number'
  | 'date'
  | 'dateTime'
  | 'time'
  | 'specialVariable'
  | 'keyword'
  | 'punct'
  | 'operator'
  | 'end'

export interface Token {
  kind: TokenKind
  /** Raw source text of the token. */
  text: string
  /**
   * Decoded value where it differs from the raw text: escape sequences resolved for
   * `string` and `delimitedIdentifier`, quotes/backticks/`@`/`$` stripped where applicable.
   */
  value: string
  span: SourceSpan
}

/**
 * Words the grammar treats as operators or literals. `as`, `contains`, `in`, `is`, `div` and
 * `mod` may still appear as element names (the parser decides by position); calendar duration
 * words (`year`, `months`, ...) lex as plain identifiers.
 */
export const KEYWORDS: ReadonlySet<string> = new Set([
  'and',
  'or',
  'xor',
  'implies',
  'div',
  'mod',
  'in',
  'contains',
  'is',
  'as',
  'true',
  'false',
])

export const SPECIAL_VARIABLES: ReadonlySet<string> = new Set(['$this', '$index', '$total'])

/** Calendar duration units usable in quantity literals, e.g. `4 days` (spec §4.1.4.7). */
export const CALENDAR_DURATION_UNITS: ReadonlySet<string> = new Set([
  'year',
  'years',
  'month',
  'months',
  'week',
  'weeks',
  'day',
  'days',
  'hour',
  'hours',
  'minute',
  'minutes',
  'second',
  'seconds',
  'millisecond',
  'milliseconds',
])
