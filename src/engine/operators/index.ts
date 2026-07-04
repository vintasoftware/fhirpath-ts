import type { BinaryOperator, TypeSpecifier, UnaryOperator } from '../../parser/ast.ts'
import type { TypedValue } from '../../values/typed-value.ts'
import type { EvaluationContext } from '../context.ts'
import { collectionOperators } from './collections.ts'
import { comparisonOperators } from './comparison.ts'
import { equalityOperators } from './equality.ts'
import { logicOperators } from './logic.ts'
import { arithmeticOperators, unaryArithmeticOperators } from './math.ts'
import { stringOperators } from './strings.ts'
import { typeOperator } from './types.ts'

export type BinaryOperatorImpl = (context: EvaluationContext, left: TypedValue[], right: TypedValue[]) => TypedValue[]

/** What each operator module exports; modules import this type-only, so no cycle. */
export type BinaryOperatorTable = Partial<Record<BinaryOperator, BinaryOperatorImpl>>

export type UnaryOperatorImpl = (context: EvaluationContext, operand: TypedValue[]) => TypedValue[]

export type TypeOperatorImpl = (
  context: EvaluationContext,
  operator: 'is' | 'as',
  operand: TypedValue[],
  type: TypeSpecifier
) => TypedValue[]

/**
 * One entry per BinaryOperator union member, assembled statically — a missing
 * operator is a compile error here, not a runtime throw.
 */
export const binaryOperators: Readonly<Record<BinaryOperator, BinaryOperatorImpl>> = {
  ...equalityOperators,
  ...comparisonOperators,
  ...logicOperators,
  ...arithmeticOperators,
  ...collectionOperators,
  ...stringOperators,
}

export const unaryOperators: Readonly<Record<UnaryOperator, UnaryOperatorImpl>> = unaryArithmeticOperators

export function evaluateBinary(
  context: EvaluationContext,
  operator: BinaryOperator,
  left: TypedValue[],
  right: TypedValue[]
): TypedValue[] {
  return binaryOperators[operator](context, left, right)
}

export function evaluateUnary(
  context: EvaluationContext,
  operator: UnaryOperator,
  operand: TypedValue[]
): TypedValue[] {
  return unaryOperators[operator](context, operand)
}

export function evaluateTypeOp(
  context: EvaluationContext,
  operator: 'is' | 'as',
  operand: TypedValue[],
  type: TypeSpecifier
): TypedValue[] {
  return typeOperator(context, operator, operand, type)
}
