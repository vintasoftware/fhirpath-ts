// The Pratt parsing approach (prefix/infix parselets driven by a precedence table) is adapted
// from Medplum's FHIRPath parser (Apache-2.0):
// https://github.com/medplum/medplum/blob/main/packages/core/src/fhirlexer/parse.ts
import { FhirPathSyntaxError, type SourceSpan } from '../errors.ts'
import { tokenize } from '../lexer/lexer.ts'
import { CALENDAR_DURATION_UNITS, type Token } from '../lexer/tokens.ts'
import type { AstNode, BinaryOperator, TypeSpecifier, UnaryOperator } from './ast.ts'
import { BindingPower, INFIX_BINDING_POWER } from './precedence.ts'

/** Keywords the grammar also accepts as element names, e.g. `'abc'.contains('b')`. */
const KEYWORDS_USABLE_AS_IDENTIFIERS: ReadonlySet<string> = new Set(['as', 'contains', 'in', 'is'])

const TYPE_OPERATORS: ReadonlySet<string> = new Set(['is', 'as'])

/**
 * Nesting far beyond anything a real expression uses. Without a cap, adversarial
 * input like ((((…)))) overflows the call stack as a native RangeError instead of
 * the FhirPathSyntaxError callers rely on catching.
 */
const MAX_DEPTH = 500

class Parser {
  private readonly tokens: Token[]
  private pos = 0
  private depth = 0
  /** Parenthesized nodes can no longer take call parentheses: `(a)(b)` is not grammatical. */
  private readonly parenthesized = new WeakSet<AstNode>()

  constructor(source: string) {
    this.tokens = tokenize(source)
  }

  parse(): AstNode {
    const expression = this.parseExpression(0)
    const trailing = this.peek()
    if (trailing.kind !== 'end') {
      throw this.error(`Unexpected '${trailing.text}' after expression`, trailing)
    }
    return expression
  }

  private parseExpression(minBindingPower: number): AstNode {
    if (++this.depth > MAX_DEPTH) {
      throw this.error(`Expression nesting exceeds ${MAX_DEPTH} levels`, this.peek())
    }
    try {
      let left = this.parsePrefix()
      for (;;) {
        const token = this.peek()
        const key = token.kind === 'operator' || token.kind === 'punct' || token.kind === 'keyword' ? token.text : ''
        const bindingPower = INFIX_BINDING_POWER[key]
        if (bindingPower === undefined || bindingPower <= minBindingPower) {
          return left
        }
        this.advance()
        left = this.parseInfix(left, token, bindingPower)
      }
    } finally {
      this.depth--
    }
  }

  private parsePrefix(): AstNode {
    const token = this.peek()
    switch (token.kind) {
      case 'end':
        throw this.error('Unexpected end of expression', token)
      case 'number':
        return this.parseNumberOrQuantity()
      case 'string':
        this.advance()
        return { kind: 'string', value: token.value, span: token.span }
      case 'date':
        this.advance()
        return { kind: 'date', text: token.value, span: token.span }
      case 'dateTime':
        this.advance()
        return { kind: 'dateTime', text: token.value, span: token.span }
      case 'time':
        this.advance()
        return { kind: 'time', text: token.value, span: token.span }
      case 'specialVariable':
        this.advance()
        return { kind: 'special', name: token.value as 'this' | 'index' | 'total', span: token.span }
      case 'identifier':
      case 'delimitedIdentifier':
        this.advance()
        return { kind: 'identifier', name: token.value, span: token.span }
      case 'keyword':
        return this.parseKeywordPrefix(token)
      case 'operator':
        return this.parseUnary(token)
      case 'punct':
        return this.parsePunctPrefix(token)
      /* v8 ignore start -- exhaustive fallback, every token kind has a case above */
      default:
        throw this.error(`Unexpected '${token.text}'`, token)
      /* v8 ignore stop */
    }
  }

  private parseKeywordPrefix(token: Token): AstNode {
    if (token.text === 'true' || token.text === 'false') {
      this.advance()
      return { kind: 'boolean', value: token.text === 'true', span: token.span }
    }
    if (KEYWORDS_USABLE_AS_IDENTIFIERS.has(token.text)) {
      this.advance()
      return { kind: 'identifier', name: token.value, span: token.span }
    }
    throw this.error(`Unexpected '${token.text}'`, token)
  }

  private parseUnary(token: Token): AstNode {
    if (token.text !== '+' && token.text !== '-') {
      throw this.error(`Unexpected '${token.text}'`, token)
    }
    this.advance()
    const operand = this.parseExpression(BindingPower.Unary)
    return {
      kind: 'unary',
      operator: token.text as UnaryOperator,
      operand,
      span: this.spanBetween(token.span, operand.span),
    }
  }

  private parsePunctPrefix(token: Token): AstNode {
    switch (token.text) {
      case '(': {
        this.advance()
        const inner = this.parseExpression(0)
        this.expect(')')
        this.parenthesized.add(inner)
        return inner
      }
      case '{': {
        this.advance()
        const close = this.expect('}')
        return { kind: 'null', span: this.spanBetween(token.span, close.span) }
      }
      case '%': {
        this.advance()
        const name = this.peek()
        if (name.kind !== 'identifier' && name.kind !== 'delimitedIdentifier' && name.kind !== 'string') {
          throw this.error('Expected a name after %', name)
        }
        this.advance()
        return { kind: 'external', name: name.value, span: this.spanBetween(token.span, name.span) }
      }
      default:
        throw this.error(`Unexpected '${token.text}'`, token)
    }
  }

  private parseNumberOrQuantity(): AstNode {
    const token = this.peek()
    this.advance()
    if (token.value.endsWith('L')) {
      // Long literals take no quantity unit.
      return { kind: 'number', text: token.value.slice(0, -1), isDecimal: false, isLong: true, span: token.span }
    }
    const next = this.peek()
    if (next.kind === 'string') {
      this.advance()
      return {
        kind: 'quantity',
        value: token.value,
        unit: next.value,
        unitKind: 'ucum',
        span: this.spanBetween(token.span, next.span),
      }
    }
    if (next.kind === 'identifier' && CALENDAR_DURATION_UNITS.has(next.value)) {
      this.advance()
      return {
        kind: 'quantity',
        value: token.value,
        unit: next.value,
        unitKind: 'calendar',
        span: this.spanBetween(token.span, next.span),
      }
    }
    return { kind: 'number', text: token.value, isDecimal: token.value.includes('.'), span: token.span }
  }

  private parseInfix(left: AstNode, token: Token, bindingPower: number): AstNode {
    switch (token.text) {
      case '.':
        return this.parseDot(left)
      case '[': {
        const index = this.parseExpression(0)
        const close = this.expect(']')
        return { kind: 'indexer', target: left, index, span: this.spanBetween(left.span, close.span) }
      }
      case '(':
        return this.parseCall(left)
      default:
        break
    }
    if (TYPE_OPERATORS.has(token.text)) {
      const type = this.parseTypeSpecifier()
      return {
        kind: 'typeOp',
        operator: token.text as 'is' | 'as',
        operand: left,
        type,
        span: this.spanBetween(left.span, type.span),
      }
    }
    // All FHIRPath binary operators are left-associative, so the right side
    // parses at this operator's own binding power.
    const right = this.parseExpression(bindingPower)
    return {
      kind: 'binary',
      operator: token.text as BinaryOperator,
      left,
      right,
      span: this.spanBetween(left.span, right.span),
    }
  }

  /**
   * After `.`, only an element name, function call, or special variable may follow.
   * Operator keywords are element names here, so `text.div` and `'abc'.contains('b')` work.
   */
  private parseDot(left: AstNode): AstNode {
    const token = this.peek()
    let right: AstNode
    if (
      token.kind === 'identifier' ||
      token.kind === 'delimitedIdentifier' ||
      (token.kind === 'keyword' && token.text !== 'true' && token.text !== 'false')
    ) {
      this.advance()
      right = { kind: 'identifier', name: token.value, span: token.span }
      if (this.peek().kind === 'punct' && this.peek().text === '(') {
        this.advance()
        right = this.parseCall(right)
      }
    } else if (token.kind === 'specialVariable') {
      this.advance()
      right = { kind: 'special', name: token.value as 'this' | 'index' | 'total', span: token.span }
    } else {
      throw this.error(`Expected an element or function name after '.', got '${token.text}'`, token)
    }
    return { kind: 'dot', left, right, span: this.spanBetween(left.span, right.span) }
  }

  private parseCall(target: AstNode): AstNode {
    if (target.kind !== 'identifier' || this.parenthesized.has(target)) {
      throw this.error('Unexpected parentheses', this.peek())
    }
    const args: AstNode[] = []
    if (!(this.peek().kind === 'punct' && this.peek().text === ')')) {
      args.push(this.parseExpression(0))
      while (this.peek().kind === 'punct' && this.peek().text === ',') {
        this.advance()
        args.push(this.parseExpression(0))
      }
    }
    const close = this.expect(')')
    return { kind: 'call', name: target.name, args, span: this.spanBetween(target.span, close.span) }
  }

  private parseTypeSpecifier(): TypeSpecifier {
    const first = this.expectTypeName()
    const parts = [first.value]
    let end = first.span
    while (this.peek().kind === 'punct' && this.peek().text === '.') {
      this.advance()
      const part = this.expectTypeName()
      parts.push(part.value)
      end = part.span
    }
    return { parts, span: this.spanBetween(first.span, end) }
  }

  private expectTypeName(): Token {
    const token = this.peek()
    if (token.kind !== 'identifier' && token.kind !== 'delimitedIdentifier') {
      throw this.error(`Expected a type name, got '${token.text}'`, token)
    }
    this.advance()
    return token
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token
  }

  private advance(): Token {
    const token = this.tokens[this.pos] as Token
    if (token.kind !== 'end') {
      this.pos += 1
    }
    return token
  }

  private expect(text: string): Token {
    const token = this.peek()
    if (token.text !== text) {
      throw this.error(`Expected '${text}', got '${token.kind === 'end' ? 'end of expression' : token.text}'`, token)
    }
    this.advance()
    return token
  }

  private error(message: string, token: Token): FhirPathSyntaxError {
    return new FhirPathSyntaxError(message, token.span)
  }

  private spanBetween(start: SourceSpan, end: SourceSpan): SourceSpan {
    return { start: start.start, end: end.end, line: start.line, column: start.column }
  }
}

/** Parse a FHIRPath expression into its AST. Throws `FhirPathSyntaxError` with a position on bad input. */
export function parse(source: string): AstNode {
  return new Parser(source).parse()
}
