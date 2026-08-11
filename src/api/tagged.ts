import { FhirPathError } from '../errors.ts'
import type { R4TypeOf } from '../r4/generated/type-maps.ts'
import type { FhirpathInput, FhirTypeName } from '../typed/infer.ts'
import { CompiledExpression, type InferredExpressionResult } from './compile.ts'

/**
 * Compiles a FHIRPath expression. The call form infers supported literal
 * expressions. Its optional input type gives relative paths a type context for
 * inference and source checks. The tagged form returns `unknown[]` because
 * TypeScript does not preserve the literal type. Tags reject interpolation; use
 * environment variables for data.
 */
export function fhirpath<
  const Expr extends string,
  const Root extends FhirTypeName,
  TResult extends unknown[] | InferredExpressionResult = InferredExpressionResult,
>(expression: Expr, inputType: Root): CompiledExpression<Expr, R4TypeOf[Root], TResult, Root>
export function fhirpath<
  const Expr extends string,
  TInput = FhirpathInput<Expr>,
  TResult extends unknown[] | InferredExpressionResult = InferredExpressionResult,
>(expression: Expr): CompiledExpression<Expr, TInput, TResult>
export function fhirpath(strings: TemplateStringsArray, ...substitutions: never[]): CompiledExpression
export function fhirpath(input: string | TemplateStringsArray, ...rest: unknown[]): CompiledExpression {
  if (typeof input === 'string') {
    // The optional input type is used by TypeScript and source checks only.
    return new CompiledExpression(input)
  }
  if (rest.length > 0) {
    throw new FhirPathError(
      'fhirpath`...` does not support interpolation; pass values as environment variables instead'
    )
  }
  return new CompiledExpression(input[0] as string)
}
