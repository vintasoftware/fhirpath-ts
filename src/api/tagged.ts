import { FhirPathError } from '../errors'
import { CompiledExpression } from './compile'

/**
 * Expression entry point, usable two ways:
 * - `fhirpath('Patient.name.given')` — the call form infers the result type
 *   (string[] here) for the supported subset; see src/typed/infer.ts.
 * - `` fhirpath`Patient.name.given` `` — the tag form; TypeScript does not carry
 *   literal types through tagged templates (TS#33304), so results are unknown[].
 * Interpolation is rejected on purpose — expressions must be static so they can be
 * statically checked (and to keep user data out of expression text).
 */
export function fhirpath<const Expr extends string>(expression: Expr): CompiledExpression<Expr>
export function fhirpath(strings: TemplateStringsArray, ...substitutions: never[]): CompiledExpression
export function fhirpath(input: string | TemplateStringsArray, ...substitutions: never[]): CompiledExpression {
  if (typeof input === 'string') {
    return new CompiledExpression(input)
  }
  if (substitutions.length > 0) {
    throw new FhirPathError(
      'fhirpath`...` does not support interpolation; pass values as environment variables instead'
    )
  }
  return new CompiledExpression(input[0] as string)
}
