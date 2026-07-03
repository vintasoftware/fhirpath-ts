import { FhirPathRuntimeError, FhirPathTypeError } from '../errors'
import { lookupFunction } from '../functions/registry'
import type { AstNode } from '../parser/ast'
import { singleton } from '../values/collection'
import { Temporal } from '../values/datetime'
import { Decimal } from '../values/decimal'
import {
  SYSTEM_BOOLEAN,
  SYSTEM_DATE,
  SYSTEM_DATETIME,
  SYSTEM_DECIMAL,
  SYSTEM_INTEGER,
  SYSTEM_QUANTITY,
  SYSTEM_STRING,
  SYSTEM_TIME,
  type TypedValue,
} from '../values/typed-value'
import { type EvaluationContext, resolveEnvironmentVariable } from './context'
import { navigateIdentifier } from './navigation'
import { evaluateBinary, evaluateTypeOp, evaluateUnary } from './operators/index'

/** Evaluate one AST node against an input collection. */
export function evaluateNode(node: AstNode, context: EvaluationContext, input: TypedValue[]): TypedValue[] {
  switch (node.kind) {
    case 'null':
      return []
    case 'boolean':
      return [{ type: SYSTEM_BOOLEAN, value: node.value }]
    case 'string':
      return [{ type: SYSTEM_STRING, value: node.value }]
    case 'number':
      return [evaluateNumberLiteral(node.text, node.isDecimal)]
    case 'date':
      return [{ type: SYSTEM_DATE, value: parseTemporalLiteral('date', node.text) }]
    case 'dateTime':
      return [{ type: SYSTEM_DATETIME, value: parseTemporalLiteral('dateTime', node.text) }]
    case 'time':
      return [{ type: SYSTEM_TIME, value: parseTemporalLiteral('time', node.text) }]
    case 'quantity':
      return [evaluateQuantityLiteral(node.value, node.unit, node.unitKind)]
    case 'identifier':
      return navigateIdentifier(context, node.name, input)
    case 'special':
      return evaluateSpecialVariable(node.name, context)
    case 'external':
      return resolveEnvironmentVariable(context, node.name)
    case 'dot':
      return evaluateNode(node.right, context, evaluateNode(node.left, context, input))
    case 'indexer':
      return evaluateIndexer(node.target, node.index, context, input)
    case 'call':
      return lookupFunction(node.name, node.args.length).evaluate(context, input, node.args, evaluateNode)
    case 'unary':
      return evaluateUnary(context, node.operator, evaluateNode(node.operand, context, input))
    case 'binary':
      return evaluateBinary(
        context,
        node.operator,
        evaluateNode(node.left, context, input),
        evaluateNode(node.right, context, input)
      )
    case 'typeOp':
      return evaluateTypeOp(context, node.operator, evaluateNode(node.operand, context, input), node.type)
    /* v8 ignore next 5 -- exhaustiveness guard, unreachable for real ASTs */
    default: {
      const unreachable: never = node
      throw new FhirPathRuntimeError(`Unhandled node ${String(unreachable)}`)
    }
  }
}

function evaluateNumberLiteral(text: string, isDecimal: boolean): TypedValue {
  if (isDecimal) {
    return { type: SYSTEM_DECIMAL, value: Decimal.fromString(text) as Decimal }
  }
  return { type: SYSTEM_INTEGER, value: Number.parseInt(text, 10) }
}

function parseTemporalLiteral(kind: 'date' | 'dateTime' | 'time', text: string): Temporal {
  const parsed =
    kind === 'date'
      ? Temporal.parseDate(text)
      : kind === 'dateTime'
        ? Temporal.parseDateTime(text)
        : Temporal.parseTime(text)
  if (!parsed) {
    throw new FhirPathRuntimeError(`Invalid ${kind} literal @${kind === 'time' ? 'T' : ''}${text}`)
  }
  return parsed
}

function evaluateQuantityLiteral(value: string, unit: string, unitKind: 'ucum' | 'calendar'): TypedValue {
  return {
    type: SYSTEM_QUANTITY,
    value: {
      value: Decimal.fromString(value) as Decimal,
      unit,
      calendar: unitKind === 'calendar',
    },
  }
}

function evaluateSpecialVariable(name: 'this' | 'index' | 'total', context: EvaluationContext): TypedValue[] {
  const frame = context.frame
  switch (name) {
    case 'this':
      return frame.thisValue
    case 'index': {
      let current: typeof frame | undefined = frame
      while (current && current.index === undefined) {
        current = current.parent
      }
      if (!current || current.index === undefined) {
        throw new FhirPathTypeError('$index is only defined inside iteration functions')
      }
      return [{ type: SYSTEM_INTEGER, value: current.index }]
    }
    case 'total': {
      let current: typeof frame | undefined = frame
      while (current && current.total === undefined) {
        current = current.parent
      }
      if (!current || current.total === undefined) {
        throw new FhirPathTypeError('$total is only defined inside aggregate()')
      }
      return current.total
    }
    /* v8 ignore next 3 -- the parser only produces the three names above */
    default:
      return []
  }
}

function evaluateIndexer(
  target: AstNode,
  indexNode: AstNode,
  context: EvaluationContext,
  input: TypedValue[]
): TypedValue[] {
  const collection = evaluateNode(target, context, input)
  const index = singleton(evaluateNode(indexNode, context, input), SYSTEM_INTEGER)
  if (index === undefined) {
    return []
  }
  // The singleton check already guarantees an Integer, and out-of-range (including
  // negative) array access yields undefined, which is the spec's empty result.
  const item = collection[index.value as number]
  return item === undefined ? [] : [item]
}
