import { booleanSingleton, wrapBoolean } from '../../values/collection'
import type { TypedValue } from '../../values/typed-value'
import { binaryOperators } from './index'

/**
 * Three-valued logic straight from the spec §6.5 truth tables. `undefined` is the
 * empty collection. Notable asymmetric cells: `false and empty` is false,
 * `true or empty` is true, `empty implies false` is empty, `false implies x` is true.
 */
type Tri = boolean | undefined

const and = (a: Tri, b: Tri): Tri => {
  if (a === false || b === false) {
    return false
  }
  return a === true && b === true ? true : undefined
}

const or = (a: Tri, b: Tri): Tri => {
  if (a === true || b === true) {
    return true
  }
  return a === false && b === false ? false : undefined
}

const xor = (a: Tri, b: Tri): Tri => {
  if (a === undefined || b === undefined) {
    return undefined
  }
  return a !== b
}

const implies = (a: Tri, b: Tri): Tri => {
  if (a === false) {
    return true
  }
  if (a === true) {
    return b
  }
  return b === true ? true : undefined
}

function logicOperator(table: (a: Tri, b: Tri) => Tri) {
  return (_context: unknown, left: TypedValue[], right: TypedValue[]): TypedValue[] =>
    wrapBoolean(table(booleanSingleton(left), booleanSingleton(right)))
}

binaryOperators.set('and', logicOperator(and))
binaryOperators.set('or', logicOperator(or))
binaryOperators.set('xor', logicOperator(xor))
binaryOperators.set('implies', logicOperator(implies))
