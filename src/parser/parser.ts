// The Pratt parsing approach (prefix/infix parselets driven by a precedence table) is adapted
// from Medplum's FHIRPath parser (Apache-2.0):
// https://github.com/medplum/medplum/blob/main/packages/core/src/fhirlexer/parse.ts
import { FhirPathSyntaxError, type SourceSpan } from '../errors.ts'
import { tokenize } from '../lexer/lexer.ts'
import { CALENDAR_DURATION_UNITS, type Token } from '../lexer/tokens.ts'
import type { AstNode, BinaryOperator, TypeSpecifier, UnaryOperator } from './ast.ts'
import { INFIX_PARSELETS, type InfixParseletRecord, PREFIX_PARSELETS, type PrefixParseletRecord } from './precedence.ts'

/** Keywords the grammar also accepts as element names, e.g. `'abc'.contains('b')`. */
const KEYWORDS_USABLE_AS_IDENTIFIERS: ReadonlySet<string> = new Set(['as', 'contains', 'in', 'is'])

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
        const parselet = this.infixParselet(token)
        if (parselet === undefined || parselet.bindingPower <= minBindingPower) {
          return left
        }
        this.advance()
        left = this.parseInfix(left, token, parselet)
      }
    } finally {
      this.depth--
    }
  }

  private parsePrefix(): AstNode {
    const token = this.peek()
    const parselet = this.prefixParselet(token)
    if (parselet === undefined) {
      throw this.error(token.kind === 'end' ? 'Unexpected end of expression' : `Unexpected '${token.text}'`, token)
    }
    switch (parselet.reducer) {
      case 'identifier':
        this.advance()
        return parselet.tokenKind === 'variable'
          ? { kind: 'special', name: token.value as 'this' | 'index' | 'total', span: token.span }
          : { kind: 'identifier', name: token.value, span: token.span }
      case 'literal':
        return this.parseLiteral(token)
      case 'unary':
        return this.parseUnary(token, parselet)
      case 'group':
      case 'empty':
      case 'external':
        return this.parsePunctPrefix(token, parselet)
    }
  }

  private parseLiteral(token: Token): AstNode {
    switch (token.kind) {
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
      case 'keyword':
        this.advance()
        return { kind: 'boolean', value: token.text === 'true', span: token.span }
      /* v8 ignore next -- prefixTokenKind admits only literal token kinds here */
      default:
        throw new Error(`Invalid literal parselet for '${token.text}'`)
    }
  }

  private parseUnary(token: Token, parselet: Extract<PrefixParseletRecord, { reducer: 'unary' }>): AstNode {
    this.advance()
    const operand = this.parseExpression(parselet.bindingPower)
    return {
      kind: 'unary',
      operator: token.text as UnaryOperator,
      operand,
      span: this.spanBetween(token.span, operand.span),
    }
  }

  private parsePunctPrefix(
    token: Token,
    parselet: Extract<PrefixParseletRecord, { reducer: 'group' | 'empty' | 'external' }>
  ): AstNode {
    switch (parselet.reducer) {
      case 'group': {
        this.advance()
        const inner = this.parseExpression(0)
        this.expect(')')
        this.parenthesized.add(inner)
        return inner
      }
      case 'empty': {
        this.advance()
        const close = this.expect('}')
        return { kind: 'null', span: this.spanBetween(token.span, close.span) }
      }
      case 'external': {
        this.advance()
        const name = this.peek()
        if (name.kind !== 'identifier' && name.kind !== 'delimitedIdentifier' && name.kind !== 'string') {
          throw this.error('Expected a name after %', name)
        }
        this.advance()
        return { kind: 'external', name: name.value, span: this.spanBetween(token.span, name.span) }
      }
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

  private parseInfix(left: AstNode, token: Token, parselet: InfixParseletRecord): AstNode {
    switch (parselet.reducer) {
      case 'dot':
        return this.parseDot(left)
      case 'indexer': {
        const index = this.parseExpression(0)
        const close = this.expect(']')
        return { kind: 'indexer', target: left, index, span: this.spanBetween(left.span, close.span) }
      }
      case 'call':
        return this.parseCall(left)
      case 'type': {
        const type = this.parseTypeSpecifier()
        return {
          kind: 'typeOp',
          operator: token.text as 'is' | 'as',
          operand: left,
          type,
          span: this.spanBetween(left.span, type.span),
        }
      }
      case 'binary': {
        const right = this.parseExpression(parselet.bindingPower)
        return {
          kind: 'binary',
          operator: token.text as BinaryOperator,
          left,
          right,
          span: this.spanBetween(left.span, right.span),
        }
      }
    }
  }

  private infixParselet(token: Token): InfixParseletRecord | undefined {
    if (token.kind !== 'operator' && token.kind !== 'keyword' && token.kind !== 'punct') return undefined
    const parselet = INFIX_PARSELETS[token.text as keyof typeof INFIX_PARSELETS] as InfixParseletRecord | undefined
    return parselet?.tokenKind === token.kind ? parselet : undefined
  }

  private prefixParselet(token: Token): PrefixParseletRecord | undefined {
    const tokenKind = prefixTokenKind(token)
    if (tokenKind === undefined) return undefined
    const key = tokenKind === 'operator' || tokenKind === 'punct' ? token.text : tokenKind
    const parselet = PREFIX_PARSELETS[key as keyof typeof PREFIX_PARSELETS] as PrefixParseletRecord | undefined
    return parselet?.tokenKind === tokenKind ? parselet : undefined
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

function prefixTokenKind(token: Token): PrefixParseletRecord['tokenKind'] | undefined {
  switch (token.kind) {
    case 'identifier':
    case 'delimitedIdentifier':
      return 'identifier'
    case 'number':
    case 'string':
    case 'date':
    case 'dateTime':
    case 'time':
      return 'literal'
    case 'specialVariable':
      return 'variable'
    case 'operator':
      return 'operator'
    case 'punct':
      return 'punct'
    case 'keyword':
      return token.text === 'true' || token.text === 'false'
        ? 'literal'
        : KEYWORDS_USABLE_AS_IDENTIFIERS.has(token.text)
          ? 'identifier'
          : undefined
    case 'end':
      return undefined
  }
}

/** Parse a FHIRPath expression into its AST. Throws `FhirPathSyntaxError` with a position on bad input. */
export function parse(source: string): AstNode {
  return new Parser(source).parse()
}
