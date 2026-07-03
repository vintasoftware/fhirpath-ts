import { FhirPathTypeError } from '../../errors.ts'
import { singleton } from '../../values/collection.ts'
import { SYSTEM_STRING, systemTypeOf, type TypedValue } from '../../values/typed-value.ts'
import { binaryOperators } from './index.ts'

/** `&` concatenates strings and, unlike `+`, treats an empty operand as `''` (spec §6.6.2). */
function concat(_context: unknown, left: TypedValue[], right: TypedValue[]): TypedValue[] {
  return [{ type: SYSTEM_STRING, value: stringOrEmpty(left) + stringOrEmpty(right) }]
}

function stringOrEmpty(input: TypedValue[]): string {
  const item = singleton(input)
  if (item === undefined) {
    return ''
  }
  if (systemTypeOf(item) !== SYSTEM_STRING) {
    throw new FhirPathTypeError(`Operator '&' expects strings, got ${item.type}`)
  }
  return item.value as string
}

binaryOperators.set('&', concat)
