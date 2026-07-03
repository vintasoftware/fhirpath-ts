import { singleton, wrapBoolean } from '../../values/collection'
import { itemMatchesType } from '../type-matching'
import { registerTypeOperator } from './index'

registerTypeOperator((context, operator, operand, type) => {
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
})
