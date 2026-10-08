import { singleton, wrapBoolean } from '../../values/collection.ts'
import { itemMatchesType } from '../type-matching.ts'
import type { TypeOperatorImpl } from './index.ts'

export const typeOperator: TypeOperatorImpl = (context, operator, operand, type) => {
  const item = singleton(operand)
  if (item === undefined) {
    return []
  }
  // `is` walks subtypes; the `as` cast demands the exact type (spec + official tests)
  // and converts FHIR primitives to System types.
  const cast = operator === 'as'
  const matches = itemMatchesType(context, item, type.parts, { exact: cast, cast })
  if (operator === 'is') {
    return wrapBoolean(matches)
  }
  return matches ? [item] : []
}
