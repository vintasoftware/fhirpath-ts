import '../functions/install.ts'

import { FhirPathRuntimeError, FhirPathTypeError } from '../errors.ts'
import { describeArity, lookupFunction } from '../functions/registry.ts'
import type { AstNode } from '../parser/ast.ts'
import { singleton } from '../values/collection.ts'
import { Temporal } from '../values/datetime.ts'
import { Decimal } from '../values/decimal.ts'
import { wrapNumeric } from '../values/numeric.ts'
import {
  SYSTEM_BOOLEAN,
  SYSTEM_DATE,
  SYSTEM_DATETIME,
  SYSTEM_DECIMAL,
  SYSTEM_INTEGER,
  SYSTEM_LONG,
  SYSTEM_QUANTITY,
  SYSTEM_STRING,
  SYSTEM_TIME,
  toCollection,
  type TypedValue,
  unwrap,
} from '../values/typed-value.ts'
import { type EvaluationContext, forkVariables, type HostFunction, resolveEnvironmentVariable } from './context.ts'
import { navigateIdentifier } from './navigation.ts'
import { evaluateBinary, evaluateTypeOp, evaluateUnary } from './operators/index.ts'

function evaluateArgument(node: AstNode, context: EvaluationContext, _input: TypedValue[]): TypedValue[] {
  // Arguments evaluate against $this (the current context item), not the function's
  // input collection: `name.given.combine(name.family)` resolves name.family on the
  // Patient. Lambda-style functions bind their own frame first, so they see each item.
  const forked = forkVariables(context)
  return evaluateNode(node, forked, forked.frame.thisValue)
}

/**
 * Call a host-supplied function (EvaluateOptions.functions): arity-check, then
 * eagerly evaluate every argument and unwrap both input and arguments to plain
 * JS values — the host boundary — and convert the plain result back.
 */
function evaluateHostFunction(
  name: string,
  host: HostFunction,
  args: AstNode[],
  context: EvaluationContext,
  input: TypedValue[]
): TypedValue[] {
  const minArity = host.minArity ?? 0
  const maxArity = host.maxArity ?? Number.POSITIVE_INFINITY
  if (args.length < minArity || args.length > maxArity) {
    throw new FhirPathTypeError(
      `Function '${name}' expects ${describeArity(minArity, maxArity)}, got ${args.length} arguments`
    )
  }
  const argValues = args.map(node => evaluateArgument(node, context, input).map(unwrap))
  return toCollection(host.fn(input.map(unwrap), ...argValues))
}

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
      return [
        node.isLong === true
          ? { type: SYSTEM_LONG, value: BigInt(node.text) }
          : evaluateNumberLiteral(node.text, node.isDecimal),
      ]
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
    case 'call': {
      const host = context.functions.get(node.name)
      if (host !== undefined) {
        return evaluateHostFunction(node.name, host, node.args, context, input)
      }
      // Each function argument evaluates in its own defineVariable() scope.
      return lookupFunction(node.name, node.args.length).evaluate(context, input, node.args, evaluateArgument)
    }
    case 'unary':
      return evaluateUnary(context, node.operator, evaluateNode(node.operand, context, input))
    case 'binary':
      // Operator operands are separate chains; variables defined in one are not
      // visible in the other (locked by the official defineVariable tests).
      return evaluateBinary(
        context,
        node.operator,
        evaluateNode(node.left, forkVariables(context), input),
        evaluateNode(node.right, forkVariables(context), input)
      )
    case 'typeOp':
      return evaluateTypeOp(context, node.operator, evaluateNode(node.operand, context, input), node.type)
    /* v8 ignore start -- exhaustiveness guard, unreachable for real ASTs */
    default: {
      const unreachable: never = node
      throw new FhirPathRuntimeError(`Unhandled node ${String(unreachable)}`)
    }
    /* v8 ignore stop */
  }
}

function evaluateNumberLiteral(text: string, isDecimal: boolean): TypedValue {
  if (isDecimal) {
    return { type: SYSTEM_DECIMAL, value: parseDecimalLiteral(text) }
  }
  // The grammar's NUMBER rule has no digit-count limit, so an integer literal can
  // exceed 32 bits (or even 64). Widen through wrapNumeric the same way arithmetic
  // results do, rather than truncating through a JS double (Number.parseInt loses
  // precision above 2^53 and never reports the overflow).
  return wrapNumeric(parseDecimalLiteral(text), 'Integer')
}

function parseDecimalLiteral(text: string): Decimal {
  const parsed = Decimal.fromString(text)
  /* v8 ignore next 3 -- the lexer only emits parseable decimal literals */
  if (parsed === undefined) {
    throw new FhirPathRuntimeError(`Invalid decimal literal ${text}`)
  }
  return parsed
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
      value: parseDecimalLiteral(value),
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
    /* v8 ignore start -- the parser only produces the three names above */
    default:
      return []
    /* v8 ignore stop */
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
  /* v8 ignore next -- both halves run across the suites; v8 misattributes this line */
  return item === undefined ? [] : [item]
}
