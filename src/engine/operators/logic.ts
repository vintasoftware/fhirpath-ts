import type { BinaryOperator } from '../../parser/ast.ts'
import { booleanSingleton, wrapBoolean } from '../../values/collection.ts'
import type { TypedValue } from '../../values/typed-value.ts'
import type { BinaryOperatorTable } from './index.ts'

/**
 * Three-valued logic straight from the spec "Boolean logic" truth tables. `undefined` is the
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

type TruthTable = (a: Tri, b: Tri) => Tri

function logicOperator(table: TruthTable) {
  return (_context: unknown, left: TypedValue[], right: TypedValue[]): TypedValue[] =>
    wrapBoolean(table(booleanSingleton(left), booleanSingleton(right)))
}

export const logicOperators = {
  and: logicOperator(and),
  or: logicOperator(or),
  xor: logicOperator(xor),
  implies: logicOperator(implies),
} satisfies BinaryOperatorTable

const TRUTH_TABLES: ReadonlyMap<BinaryOperator, TruthTable> = new Map([
  ['and', and],
  ['or', or],
  ['xor', xor],
  ['implies', implies],
])

/**
 * The result of a logic operator whose left operand decides it, whatever the
 * right operand is: `false and x`, `true or x`, `false implies x`, `{} xor x`.
 * The evaluator then skips the right operand, as the spec allows, so a type
 * guard such as `$this is Period implies start.exists()` keeps the right
 * operand from running on other types, as the analyzer's type guards assume.
 */
export function decidedByLeft(operator: BinaryOperator, left: TypedValue[]): TypedValue[] | undefined {
  const table = TRUTH_TABLES.get(operator)
  if (table === undefined) {
    return undefined
  }
  const a = booleanSingleton(left)
  const result = table(a, true)
  return result === table(a, false) && result === table(a, undefined) ? wrapBoolean(result) : undefined
}
