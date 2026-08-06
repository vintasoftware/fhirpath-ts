import { FhirPathError } from '../errors.ts'
import type { R4TypeOf } from '../r4/generated/type-maps.ts'
import type { FhirpathInput, FhirpathResult, FhirpathResultIn, FhirTypeName } from '../typed/infer.ts'
import { CompiledExpression } from './compile.ts'

/**
 * Expression entry point, usable three ways:
 * - `fhirpath('Patient.name.given')` — the call form infers the result type
 *   (string[] here) for the supported subset; see src/typed/infer.ts. `TInput`/
 *   `TResult` can be overridden the same way as `compile()`, e.g. to target
 *   `@medplum/fhirtypes` types instead of the built-in inference.
 * - `fhirpath('value.ofType(Quantity).value', 'Observation')` — the same, with
 *   the type the expression runs against. A relative path then infers like a DTO
 *   column (`decimal[]` here) instead of degrading, the input type is that
 *   resource rather than one guessed from the path, and the static checkers
 *   analyze the expression against it — which is the only way they can, for an
 *   expression held in a `const` and evaluated somewhere else. Like a project
 *   column's `type`, it is a declaration: nothing checks it at runtime.
 * - `` fhirpath`Patient.name.given` `` — the tag form; TypeScript does not carry
 *   literal types through tagged templates (TS#33304), so results are unknown[].
 * Interpolation is rejected on purpose — expressions must be static so they can be
 * statically checked (and to keep user data out of expression text).
 */
export function fhirpath<
  const Expr extends string,
  const Root extends FhirTypeName,
  TResult extends unknown[] = FhirpathResultIn<Expr, Root>,
>(expression: Expr, inputType: Root): CompiledExpression<Expr, R4TypeOf[Root], TResult>
export function fhirpath<
  const Expr extends string,
  TInput = FhirpathInput<Expr>,
  TResult extends unknown[] = FhirpathResult<Expr>,
>(expression: Expr): CompiledExpression<Expr, TInput, TResult>
export function fhirpath(strings: TemplateStringsArray, ...substitutions: never[]): CompiledExpression
export function fhirpath(input: string | TemplateStringsArray, ...rest: unknown[]): CompiledExpression {
  if (typeof input === 'string') {
    // `rest[0]` is the declared input type: a compile-time and check-time
    // declaration, with nothing for the evaluator to do.
    return new CompiledExpression(input)
  }
  if (rest.length > 0) {
    throw new FhirPathError(
      'fhirpath`...` does not support interpolation; pass values as environment variables instead'
    )
  }
  return new CompiledExpression(input[0] as string)
}
