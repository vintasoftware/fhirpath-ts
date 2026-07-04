import { booleanSingleton, wrapBoolean } from '../../values/collection.ts'
import type { TypedValue } from '../../values/typed-value.ts'
import type { BinaryOperatorTable } from './index.ts'

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

export const logicOperators = {
  and: logicOperator(and),
  or: logicOperator(or),
  xor: logicOperator(xor),
  implies: logicOperator(implies),
} satisfies BinaryOperatorTable
