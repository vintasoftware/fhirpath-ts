/**
 * Binding powers derived from the spec's 13-level operator precedence table
 * (https://hl7.org/fhirpath/#operator-precedence). Higher binds tighter; the
 * spec numbers levels the other way around (1 = `.`, 13 = `implies`).
 */
export const BindingPower = {
  Implies: 1,
  OrXor: 2,
  And: 3,
  Membership: 4,
  Equality: 5,
  Comparison: 6,
  Union: 7,
  TypeOps: 8,
  Additive: 9,
  Multiplicative: 10,
  Unary: 11,
  Indexer: 12,
  Dot: 13,
  FunctionCall: 14,
} as const

/** Binding power for every infix (and postfix) construct, keyed by token text. */
export const INFIX_BINDING_POWER: Readonly<Record<string, number>> = {
  implies: BindingPower.Implies,
  or: BindingPower.OrXor,
  xor: BindingPower.OrXor,
  and: BindingPower.And,
  in: BindingPower.Membership,
  contains: BindingPower.Membership,
  '=': BindingPower.Equality,
  '~': BindingPower.Equality,
  '!=': BindingPower.Equality,
  '!~': BindingPower.Equality,
  '<': BindingPower.Comparison,
  '>': BindingPower.Comparison,
  '<=': BindingPower.Comparison,
  '>=': BindingPower.Comparison,
  '|': BindingPower.Union,
  is: BindingPower.TypeOps,
  as: BindingPower.TypeOps,
  '+': BindingPower.Additive,
  '-': BindingPower.Additive,
  '&': BindingPower.Additive,
  '*': BindingPower.Multiplicative,
  '/': BindingPower.Multiplicative,
  div: BindingPower.Multiplicative,
  mod: BindingPower.Multiplicative,
  '[': BindingPower.Indexer,
  '.': BindingPower.Dot,
  '(': BindingPower.FunctionCall,
}
