import { singleton, wrapBoolean } from '../../values/collection.ts'
import { itemMatchesType } from '../type-matching.ts'
import type { TypeOperatorImpl } from './index.ts'

export const typeOperator: TypeOperatorImpl = (context, operator, operand, type) => {
  const item = singleton(operand)
  if (item === undefined) {
    return []
  }
  // `is` walks subtypes; the `as` cast demands the exact type (spec + official tests).
  const matches = itemMatchesType(context, item, type.parts, { exact: operator === 'as' })
  if (operator === 'is') {
    return wrapBoolean(matches)
  }
  return matches ? [item] : []
}
