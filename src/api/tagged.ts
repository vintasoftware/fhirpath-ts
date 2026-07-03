import { FhirPathError } from '../errors'
import { CompiledExpression } from './compile'

/**
 * Tagged-template entry point: `` fhirpath`Patient.name.given` ``.
 * Interpolation is rejected on purpose — expressions must be static so they can be
 * statically checked (and to keep user data out of expression text).
 */
export function fhirpath(strings: TemplateStringsArray, ...substitutions: never[]): CompiledExpression {
  if (substitutions.length > 0) {
    throw new FhirPathError(
      'fhirpath`...` does not support interpolation; pass values as environment variables instead'
    )
  }
  return new CompiledExpression(strings[0] as string)
}
