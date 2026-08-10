import { KEYWORDS } from '../lexer/tokens.ts'
import type { AstNode } from './ast.ts'
import { BindingPower, INFIX_BINDING_POWER } from './precedence.ts'

const ATOMIC = 15

function bindingPowerOf(node: AstNode): number {
  switch (node.kind) {
    case 'call':
      return BindingPower.FunctionCall
    case 'dot':
      return BindingPower.Dot
    case 'indexer':
      return BindingPower.Indexer
    case 'unary':
      return BindingPower.Unary
    case 'typeOp':
      return BindingPower.TypeOps
    case 'binary':
      return INFIX_BINDING_POWER[node.operator] as number
    default:
      return ATOMIC
  }
}

const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

function printIdentifier(name: string): string {
  if (PLAIN_IDENTIFIER.test(name) && !KEYWORDS.has(name)) {
    return name
  }
  return `\`${escapeQuoted(name, '`')}\``
}

function escapeQuoted(value: string, quote: string): string {
  let result = ''
  for (const ch of value) {
    if (ch === quote || ch === '\\') {
      result += `\\${ch}`
    } else if (ch === '\n') {
      result += '\\n'
    } else if (ch === '\r') {
      result += '\\r'
    } else if (ch === '\t') {
      result += '\\t'
    } else if (ch === '\f') {
      result += '\\f'
    } else if (ch < ' ') {
      result += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`
    } else {
      result += ch
    }
  }
  return result
}

function print(node: AstNode, contextBindingPower: number): string {
  const text = printInner(node)
  return bindingPowerOf(node) < contextBindingPower ? `(${text})` : text
}

function printInner(node: AstNode): string {
  switch (node.kind) {
    case 'null':
      return '{}'
    case 'boolean':
      return node.value ? 'true' : 'false'
    case 'string':
      return `'${escapeQuoted(node.value, "'")}'`
    case 'number':
      return node.isLong ? `${node.text}L` : node.text
    case 'date':
      return `@${node.text}`
    case 'dateTime':
      return `@${node.text}`
    case 'time':
      return `@T${node.text}`
    case 'quantity':
      return node.unitKind === 'calendar'
        ? `${node.value} ${node.unit}`
        : `${node.value} '${escapeQuoted(node.unit, "'")}'`
    case 'identifier':
      return printIdentifier(node.name)
    case 'special':
      return `$${node.name}`
    case 'external':
      return `%${printIdentifier(node.name)}`
    case 'dot':
      return `${print(node.left, BindingPower.Dot)}.${printInner(node.right)}`
    case 'indexer':
      return `${print(node.target, BindingPower.Indexer)}[${print(node.index, 0)}]`
    case 'call':
      return `${printIdentifier(node.name)}(${node.args.map(arg => print(arg, 0)).join(', ')})`
    case 'unary':
      return `${node.operator}${print(node.operand, BindingPower.Unary)}`
    case 'typeOp':
      return `${print(node.operand, BindingPower.TypeOps)} ${node.operator} ${node.type.parts.map(printIdentifier).join('.')}`
    case 'binary': {
      const bindingPower = INFIX_BINDING_POWER[node.operator] as number
      return `${print(node.left, bindingPower)} ${node.operator} ${print(node.right, bindingPower + 1)}`
    }
    /* v8 ignore start -- exhaustive fallback, unreachable for real ASTs */
    default: {
      const unreachable: never = node
      throw new Error(`Unhandled node ${String(unreachable)}`)
    }
    /* v8 ignore stop */
  }
}

/** Render an AST back to a canonical FHIRPath expression that parses to the same tree. */
export function printExpression(node: AstNode): string {
  return print(node, 0)
}
