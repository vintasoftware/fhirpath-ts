import type { EvaluationContext } from '../engine/context.ts'
import { FhirPathTypeError } from '../errors.ts'
import type { AstNode } from '../parser/ast.ts'
import type { TypedValue } from '../values/typed-value.ts'

/**
 * A FHIRPath function. Arguments arrive as unevaluated ASTs so functions with
 * expression parameters (`where`, `select`, `iif`, `aggregate`, ...) control their
 * own scoping and laziness; plain-value functions evaluate them via the callback.
 */
export interface FhirPathFunction {
  /** Inclusive argument count range. */
  minArity: number
  maxArity: number
  evaluate(
    context: EvaluationContext,
    input: TypedValue[],
    args: AstNode[],
    evaluateNode: (node: AstNode, context: EvaluationContext, input: TypedValue[]) => TypedValue[]
  ): TypedValue[]
}

/**
 * The argument AST at `index`. `lookupFunction` has already enforced the arity
 * range, so within a registered `evaluate` the node exists whenever `index` is
 * below the function's minArity; this replaces the unchecked `args[i] as AstNode`
 * casts with one guarded accessor.
 */
export function argAt(args: AstNode[], index: number): AstNode {
  const node = args[index]
  /* v8 ignore next 3 -- arity is validated before evaluate runs */
  if (node === undefined) {
    throw new FhirPathTypeError(`Missing required argument at position ${index}`)
  }
  return node
}

/** Function table; the per-section function modules add entries (append-only). */
export const functions = new Map<string, FhirPathFunction>()

export function registerFunction(name: string, fn: FhirPathFunction): void {
  if (functions.has(name)) {
    // 100+ names across 20 modules: a copy-paste collision would silently
    // replace an implementation, so fail loudly at import time instead.
    throw new Error(`FHIRPath function '${name}' is registered twice`)
  }
  functions.set(name, fn)
}

export function lookupFunction(name: string, argCount: number): FhirPathFunction {
  const fn = functions.get(name)
  if (!fn) {
    throw new FhirPathTypeError(`Unrecognized function '${name}'`)
  }
  if (argCount < fn.minArity || argCount > fn.maxArity) {
    throw new FhirPathTypeError(
      `Function '${name}' expects ${describeArity(fn.minArity, fn.maxArity)}, got ${argCount} arguments`
    )
  }
  return fn
}

/** Human-readable arity range, e.g. "1 argument", "2 arguments", "1 to 3 arguments". */
export function describeArity(minArity: number, maxArity: number): string {
  if (minArity === maxArity) {
    return minArity === 1 ? '1 argument' : `${minArity} arguments`
  }
  if (maxArity === Number.POSITIVE_INFINITY) {
    return minArity === 1 ? 'at least 1 argument' : `at least ${minArity} arguments`
  }
  return `${minArity} to ${maxArity} arguments`
}
