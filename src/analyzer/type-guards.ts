import type { AstNode, BinaryOperator } from '../parser/ast.ts'

/**
 * Type guards: a type test on the focus that decides whether another operand
 * runs. The analyzer checks that operand against the focus types the test
 * leaves:
 *
 * - `A implies B`, `A and B`, `iif(A, B, ...)`: B runs only when A is true.
 * - `A or B`, `iif(A, ..., B)`: B runs only when A is false.
 *
 * The evaluator makes this hold: `iif()` runs one branch, and `decidedByLeft`
 * skips the right operand of a logic operator whose left operand decides it.
 *
 * A is `$this is T`, `$this.is(T)`, `is(T)`, `A.not()`, or an `and`/`or` of
 * guards. A test on anything but the focus, such as `$this.start is dateTime`,
 * tells nothing about the focus. When no type is left, the operand cannot run
 * on a value, and checks that read the focus types find nothing to report.
 */

/** The focus types a guard narrows. */
export interface FocusTypes {
  /** Static candidates: each value has one of these types or a subtype of it. */
  types: string[]
  /** The runtime type of each focus item, when strict evaluation knows them. */
  exactTypes?: string[]
}

/** The model rules a guard reads, supplied by the analyzer. */
export interface FocusTypeRules {
  /** The canonical type a type specifier names, or undefined when it names none. */
  resolve(parts: string[]): string | undefined
  /** Whether a value of `type` passes `is` against the specifier, by the runtime rule. */
  passes(type: string, parts: string[]): boolean
  isSubtypeOf(type: string, base: string): boolean
}

/** The value of the left operand under which each guarding operator runs its right operand. */
export const GUARDED_RIGHT_OPERAND: ReadonlyMap<BinaryOperator, boolean> = new Map([
  ['implies', true],
  ['and', true],
  ['or', false],
])

/**
 * The focus types left when `condition` is `outcome`, or undefined when the
 * condition tells nothing about the focus. An empty `condition` has an empty
 * focus, so three-valued logic adds no case.
 */
export function narrowFocus(
  condition: AstNode,
  outcome: boolean,
  focus: FocusTypes,
  rules: FocusTypeRules
): FocusTypes | undefined {
  const tested = focusTypeTest(condition)
  if (tested !== undefined) {
    const target = rules.resolve(tested)
    return target === undefined ? undefined : narrowByTest(focus, tested, target, outcome, rules)
  }
  if (condition.kind === 'dot' && condition.right.kind === 'call' && condition.right.name === 'not') {
    return condition.right.args.length === 0 ? narrowFocus(condition.left, !outcome, focus, rules) : undefined
  }
  if (condition.kind !== 'binary' || (condition.operator !== 'and' && condition.operator !== 'or')) {
    return undefined
  }
  // `A and B` true and `A or B` false hold both sides; the other outcomes hold either side.
  const bothHold = (condition.operator === 'and') === outcome
  const left = narrowFocus(condition.left, outcome, focus, rules)
  if (bothHold) {
    return narrowFocus(condition.right, outcome, left ?? focus, rules) ?? left
  }
  const right = narrowFocus(condition.right, outcome, focus, rules)
  if (left === undefined || right === undefined) {
    return undefined
  }
  return {
    types: [...new Set([...left.types, ...right.types])],
    ...(focus.exactTypes !== undefined && {
      exactTypes: focus.exactTypes.filter(type => left.exactTypes?.includes(type) || right.exactTypes?.includes(type)),
    }),
  }
}

/**
 * The focus types for which `is` against `parts` gives `outcome`. A runtime
 * type answers by itself. A static candidate that fails the test may still
 * hold a value of the tested subtype, so a true outcome narrows it to `target`.
 */
function narrowByTest(
  focus: FocusTypes,
  parts: string[],
  target: string,
  outcome: boolean,
  rules: FocusTypeRules
): FocusTypes {
  const passes = (type: string): boolean => rules.passes(type, parts)
  const types = outcome
    ? focus.types.flatMap(type => (passes(type) ? [type] : rules.isSubtypeOf(target, type) ? [target] : []))
    : focus.types.filter(type => !passes(type))
  return {
    types: [...new Set(types)],
    ...(focus.exactTypes !== undefined && { exactTypes: focus.exactTypes.filter(type => passes(type) === outcome) }),
  }
}

/** The type specifier a condition tests the focus against, if it is such a test. */
function focusTypeTest(condition: AstNode): string[] | undefined {
  if (condition.kind === 'typeOp') {
    return condition.operator === 'is' && isThis(condition.operand) ? condition.type.parts : undefined
  }
  const call = condition.kind === 'dot' && isThis(condition.left) ? condition.right : condition
  if (call.kind !== 'call' || call.name !== 'is' || call.args.length !== 1) {
    return undefined
  }
  return typeSpecifierParts(call.args[0] as AstNode)
}

function isThis(node: AstNode): boolean {
  return node.kind === 'special' && node.name === 'this'
}

/** The parts of a type specifier written as a function argument: `Period` or `FHIR.Period`. */
export function typeSpecifierParts(node: AstNode): string[] | undefined {
  if (node.kind === 'identifier') {
    return [node.name]
  }
  if (node.kind === 'dot' && node.left.kind === 'identifier' && node.right.kind === 'identifier') {
    return [node.left.name, node.right.name]
  }
  return undefined
}
