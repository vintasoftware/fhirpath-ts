import { FhirPathSyntaxError, type SourceSpan } from '../errors.ts'
import { KEYWORDS, SPECIAL_VARIABLES, type Token, type TokenKind } from './tokens.ts'

const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9'
const isIdentifierStart = (ch: string): boolean => (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_'
const isIdentifierPart = (ch: string): boolean => isIdentifierStart(ch) || isDigit(ch)
const isWhitespace = (ch: string): boolean => ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === '\f'
const isHexDigit = (ch: string): boolean => isDigit(ch) || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F')

const ESCAPES: Readonly<Record<string, string>> = {
  "'": "'",
  '"': '"',
  '`': '`',
  '/': '/',
  '\\': '\\',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
}

const TWO_CHAR_OPERATORS: ReadonlySet<string> = new Set(['!=', '!~', '<=', '>='])
const ONE_CHAR_OPERATORS: ReadonlySet<string> = new Set(['=', '~', '<', '>', '+', '-', '*', '/', '|', '&'])
const PUNCT: ReadonlySet<string> = new Set(['(', ')', '[', ']', '{', '}', '.', ',', '%'])

class Lexer {
  private readonly source: string
  private pos = 0

  constructor(source: string) {
    this.source = source
  }

  tokenize(): Token[] {
    const tokens: Token[] = []
    for (;;) {
      const token = this.next()
      tokens.push(token)
      if (token.kind === 'end') {
        return tokens
      }
    }
  }

  private next(): Token {
    this.skipTrivia()
    if (this.pos >= this.source.length) {
      return this.token('end', this.pos, '')
    }
    const start = this.pos
    const ch = this.source[this.pos] as string
    if (isIdentifierStart(ch)) {
      return this.readIdentifier(start)
    }
    if (isDigit(ch)) {
      return this.readNumber(start)
    }
    switch (ch) {
      case "'":
        return this.readString(start)
      case '`':
        return this.readDelimitedIdentifier(start)
      case '@':
        return this.readDateTimeLiteral(start)
      case '$':
        return this.readSpecialVariable(start)
      default:
        return this.readOperatorOrPunct(start)
    }
  }

  private skipTrivia(): void {
    while (this.pos < this.source.length) {
      const ch = this.source[this.pos] as string
      if (isWhitespace(ch)) {
        this.advance()
      } else if (ch === '/' && this.source[this.pos + 1] === '/') {
        while (this.pos < this.source.length && this.source[this.pos] !== '\n') {
          this.advance()
        }
      } else if (ch === '/' && this.source[this.pos + 1] === '*') {
        const start = this.spanFrom(this.pos)
        this.advance()
        this.advance()
        while (this.pos < this.source.length && !(this.source[this.pos] === '*' && this.source[this.pos + 1] === '/')) {
          this.advance()
        }
        if (this.pos >= this.source.length) {
          throw new FhirPathSyntaxError('Unterminated comment', start)
        }
        this.advance()
        this.advance()
      } else {
        return
      }
    }
  }

  private readIdentifier(start: number): Token {
    while (this.pos < this.source.length && isIdentifierPart(this.source[this.pos] as string)) {
      this.advance()
    }
    const text = this.source.slice(start, this.pos)
    return this.token(KEYWORDS.has(text) ? 'keyword' : 'identifier', start, text)
  }

  private readNumber(start: number): Token {
    while (this.pos < this.source.length && isDigit(this.source[this.pos] as string)) {
      this.advance()
    }
    // A '.' continues the number only when a digit follows; `5.single()` is Integer 5 then '.'.
    if (this.source[this.pos] === '.' && isDigit(this.source[this.pos + 1] ?? '')) {
      this.advance()
      while (this.pos < this.source.length && isDigit(this.source[this.pos] as string)) {
        this.advance()
      }
    }
    const text = this.source.slice(start, this.pos)
    return this.token('number', start, text)
  }

  private readString(start: number): Token {
    const value = this.readQuoted(start, "'", 'string literal')
    return this.token('string', start, value)
  }

  private readDelimitedIdentifier(start: number): Token {
    const value = this.readQuoted(start, '`', 'delimited identifier')
    if (value === '') {
      throw new FhirPathSyntaxError('Empty delimited identifier', this.spanFrom(start))
    }
    return this.token('delimitedIdentifier', start, value)
  }

  private readQuoted(start: number, quote: string, what: string): string {
    this.advance()
    let value = ''
    while (this.pos < this.source.length) {
      const ch = this.source[this.pos] as string
      if (ch === quote) {
        this.advance()
        return value
      }
      if (ch === '\\') {
        value += this.readEscape()
      } else {
        value += ch
        this.advance()
      }
    }
    throw new FhirPathSyntaxError(`Unterminated ${what}`, this.spanFrom(start))
  }

  private readEscape(): string {
    const start = this.pos
    this.advance()
    const ch = this.source[this.pos]
    if (ch === undefined) {
      throw new FhirPathSyntaxError('Unterminated escape sequence', this.spanFrom(start))
    }
    if (ch === 'u') {
      this.advance()
      let code = ''
      for (let i = 0; i < 4; i++) {
        const hex = this.source[this.pos]
        if (hex === undefined || !isHexDigit(hex)) {
          throw new FhirPathSyntaxError('Unicode escape must be \\u followed by 4 hex digits', this.spanFrom(start))
        }
        code += hex
        this.advance()
      }
      return String.fromCharCode(Number.parseInt(code, 16))
    }
    const resolved = ESCAPES[ch]
    if (resolved === undefined) {
      throw new FhirPathSyntaxError(`Invalid escape sequence \\${ch}`, this.spanFrom(start))
    }
    this.advance()
    return resolved
  }

  private readDateTimeLiteral(start: number): Token {
    this.advance()
    if (this.source[this.pos] === 'T') {
      this.advance()
      this.readTimeFormat(start, 'time literal')
      return this.token('time', start, this.source.slice(start + 2, this.pos))
    }
    this.readDigits(2, start, 'date literal')
    this.readDigits(2, start, 'date literal')
    // Like the reference ANTLR lexer, a component is consumed only when complete:
    // `@2014-5` is the date @2014 followed by the operator '-' and the number 5.
    if (this.hasTwoDigitComponent('-')) {
      this.advance()
      this.readDigits(2, start, 'date literal')
      if (this.hasTwoDigitComponent('-')) {
        this.advance()
        this.readDigits(2, start, 'date literal')
      }
    }
    if (this.source[this.pos] !== 'T') {
      return this.token('date', start, this.source.slice(start + 1, this.pos))
    }
    this.advance()
    if (isDigit(this.source[this.pos] ?? '')) {
      this.readTimeFormat(start, 'dateTime literal')
      this.readTimezoneOffset()
    }
    return this.token('dateTime', start, this.source.slice(start + 1, this.pos))
  }

  private readTimeFormat(start: number, what: string): void {
    this.readDigits(2, start, what)
    if (this.hasTwoDigitComponent(':')) {
      this.advance()
      this.readDigits(2, start, what)
      if (this.hasTwoDigitComponent(':')) {
        this.advance()
        this.readDigits(2, start, what)
        if (this.source[this.pos] === '.' && isDigit(this.source[this.pos + 1] ?? '')) {
          this.advance()
          while (isDigit(this.source[this.pos] ?? '')) {
            this.advance()
          }
        }
      }
    }
  }

  private hasTwoDigitComponent(separator: string): boolean {
    return (
      this.source[this.pos] === separator &&
      isDigit(this.source[this.pos + 1] ?? '') &&
      isDigit(this.source[this.pos + 2] ?? '')
    )
  }

  private readTimezoneOffset(): void {
    const ch = this.source[this.pos]
    if (ch === 'Z') {
      this.advance()
      return
    }
    // '+'/'-' is an offset only in the full hh:mm shape; otherwise it is an operator, e.g. `@2014-01-01T10 - 3 days`.
    if (
      (ch === '+' || ch === '-') &&
      isDigit(this.source[this.pos + 1] ?? '') &&
      isDigit(this.source[this.pos + 2] ?? '') &&
      this.source[this.pos + 3] === ':' &&
      isDigit(this.source[this.pos + 4] ?? '') &&
      isDigit(this.source[this.pos + 5] ?? '')
    ) {
      for (let i = 0; i < 6; i++) {
        this.advance()
      }
    }
  }

  private readDigits(count: number, start: number, what: string): void {
    for (let i = 0; i < count; i++) {
      const ch = this.source[this.pos]
      if (ch === undefined || !isDigit(ch)) {
        throw new FhirPathSyntaxError(`Invalid ${what}`, this.spanFrom(start))
      }
      this.advance()
    }
  }

  private readSpecialVariable(start: number): Token {
    this.advance()
    while (this.pos < this.source.length && isIdentifierPart(this.source[this.pos] as string)) {
      this.advance()
    }
    const text = this.source.slice(start, this.pos)
    if (!SPECIAL_VARIABLES.has(text)) {
      throw new FhirPathSyntaxError(`Unknown special variable ${text}`, this.spanFrom(start))
    }
    return this.token('specialVariable', start, text.slice(1))
  }

  private readOperatorOrPunct(start: number): Token {
    const two = this.source.slice(this.pos, this.pos + 2)
    if (TWO_CHAR_OPERATORS.has(two)) {
      this.advance()
      this.advance()
      return this.token('operator', start, two)
    }
    const ch = this.source[this.pos] as string
    if (ONE_CHAR_OPERATORS.has(ch)) {
      this.advance()
      return this.token('operator', start, ch)
    }
    if (PUNCT.has(ch)) {
      this.advance()
      return this.token('punct', start, ch)
    }
    throw new FhirPathSyntaxError(`Unexpected character '${ch}'`, this.spanFrom(start))
  }

  private advance(): void {
    this.pos += 1
  }

  private token(kind: TokenKind, start: number, value: string): Token {
    return {
      kind,
      text: this.source.slice(start, this.pos),
      value,
      span: this.spanFrom(start),
    }
  }

  /** Span from `start` to the current position; line/column point at `start`. */
  private spanFrom(start: number): SourceSpan {
    let line = 1
    let column = 1
    for (let i = 0; i < start; i++) {
      if (this.source[i] === '\n') {
        line += 1
        column = 1
      } else {
        column += 1
      }
    }
    return { start, end: this.pos, line, column }
  }
}

/** Split a FHIRPath expression into tokens. The last token always has kind `end`. */
export function tokenize(source: string): Token[] {
  return new Lexer(source).tokenize()
}
