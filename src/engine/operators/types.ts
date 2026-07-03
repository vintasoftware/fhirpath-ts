import { singleton, wrapBoolean } from '../../values/collection'
import { itemMatchesType } from '../type-matching'
import { registerTypeOperator } from './index'

registerTypeOperator((context, operator, operand, type) => {
  const item = singleton(operand)
  if (item === undefined) {
    return []
  }
  const matches = itemMatchesType(context, item, type.parts)
  if (operator === 'is') {
    return wrapBoolean(matches)
  }
  return matches ? [item] : []
})
