import { FhirPathRuntimeError } from '../../errors.ts'
import type { BinaryOperator, TypeSpecifier, UnaryOperator } from '../../parser/ast.ts'
import type { TypedValue } from '../../values/typed-value.ts'
import type { EvaluationContext } from '../context.ts'

export type BinaryOperatorImpl = (context: EvaluationContext, left: TypedValue[], right: TypedValue[]) => TypedValue[]

/** Filled in by the operator modules; registration is append-only. */
export const binaryOperators = new Map<BinaryOperator, BinaryOperatorImpl>()

export function evaluateBinary(
  context: EvaluationContext,
  operator: BinaryOperator,
  left: TypedValue[],
  right: TypedValue[]
): TypedValue[] {
  const impl = binaryOperators.get(operator)
  if (!impl) {
    throw new FhirPathRuntimeError(`Operator '${operator}' is not implemented yet`)
  }
  return impl(context, left, right)
}

export type UnaryOperatorImpl = (context: EvaluationContext, operand: TypedValue[]) => TypedValue[]

export const unaryOperators = new Map<UnaryOperator, UnaryOperatorImpl>()

export function evaluateUnary(
  context: EvaluationContext,
  operator: UnaryOperator,
  operand: TypedValue[]
): TypedValue[] {
  const impl = unaryOperators.get(operator)
  if (!impl) {
    throw new FhirPathRuntimeError(`Operator 'unary ${operator}' is not implemented yet`)
  }
  return impl(context, operand)
}

export type TypeOperatorImpl = (
  context: EvaluationContext,
  operator: 'is' | 'as',
  operand: TypedValue[],
  type: TypeSpecifier
) => TypedValue[]

let typeOperatorImpl: TypeOperatorImpl | undefined

export function registerTypeOperator(impl: TypeOperatorImpl): void {
  typeOperatorImpl = impl
}

export function evaluateTypeOp(
  context: EvaluationContext,
  operator: 'is' | 'as',
  operand: TypedValue[],
  type: TypeSpecifier
): TypedValue[] {
  if (!typeOperatorImpl) {
    throw new FhirPathRuntimeError(`Operator '${operator}' is not implemented yet`)
  }
  return typeOperatorImpl(context, operator, operand, type)
}
