import type { SourceSpan } from '../errors.ts'

export type BinaryOperator =
  | '*'
  | '/'
  | 'div'
  | 'mod'
  | '+'
  | '-'
  | '&'
  | '|'
  | '<'
  | '>'
  | '<='
  | '>='
  | '='
  | '~'
  | '!='
  | '!~'
  | 'in'
  | 'contains'
  | 'and'
  | 'or'
  | 'xor'
  | 'implies'

export type UnaryOperator = '+' | '-'

/** A possibly qualified type name, e.g. `Patient`, `FHIR.Patient`, or `System.Boolean`. */
export interface TypeSpecifier {
  parts: string[]
  span: SourceSpan
}

interface BaseNode {
  span: SourceSpan
}

/** The empty collection literal `{}`. */
export interface NullLiteralNode extends BaseNode {
  kind: 'null'
}

export interface BooleanLiteralNode extends BaseNode {
  kind: 'boolean'
  value: boolean
}

export interface StringLiteralNode extends BaseNode {
  kind: 'string'
  value: string
}

/** Integer, Long (5L), or Decimal literal; the raw text keeps float precision intact. */
export interface NumberLiteralNode extends BaseNode {
  kind: 'number'
  text: string
  isDecimal: boolean
  isLong?: boolean
}

export interface DateLiteralNode extends BaseNode {
  kind: 'date'
  /** Literal text without the `@`, e.g. `2014-01`. */
  text: string
}

export interface DateTimeLiteralNode extends BaseNode {
  kind: 'dateTime'
  /** Literal text without the `@`, e.g. `2014-01-25T14:30:00Z` or `2014T`. */
  text: string
}

export interface TimeLiteralNode extends BaseNode {
  kind: 'time'
  /** Literal text without the `@T`, e.g. `14:30`. */
  text: string
}

export interface QuantityLiteralNode extends BaseNode {
  kind: 'quantity'
  value: string
  unit: string
  /** `'mg'` style UCUM strings vs bare calendar words like `days`. */
  unitKind: 'ucum' | 'calendar'
}

/** A path segment or element name, e.g. `Patient` or `name`. */
export interface IdentifierNode extends BaseNode {
  kind: 'identifier'
  name: string
}

/** `$this`, `$index`, or `$total`. */
export interface SpecialVariableNode extends BaseNode {
  kind: 'special'
  name: 'this' | 'index' | 'total'
}

/** An environment variable, e.g. `%ucum` or `` %`vs-observation-vitalsignresult` ``. */
export interface ExternalConstantNode extends BaseNode {
  kind: 'external'
  name: string
}

export interface DotNode extends BaseNode {
  kind: 'dot'
  left: AstNode
  right: AstNode
}

export interface IndexerNode extends BaseNode {
  kind: 'indexer'
  target: AstNode
  index: AstNode
}

/** The `asc` or `desc` qualifier after a `sort()` key (spec "sort"). */
export type SortDirection = 'asc' | 'desc'

export interface FunctionCallNode extends BaseNode {
  kind: 'call'
  name: string
  args: AstNode[]
  /**
   * The qualifier written after each `sort()` key, by argument position. Set
   * only on a `sort()` call that writes at least one.
   */
  directions?: (SortDirection | undefined)[]
}

export interface UnaryNode extends BaseNode {
  kind: 'unary'
  operator: UnaryOperator
  operand: AstNode
}

export interface BinaryNode extends BaseNode {
  kind: 'binary'
  operator: BinaryOperator
  left: AstNode
  right: AstNode
}

/** `expr is Type` or `expr as Type`. */
export interface TypeOpNode extends BaseNode {
  kind: 'typeOp'
  operator: 'is' | 'as'
  operand: AstNode
  type: TypeSpecifier
}

/** One `name : value` pair of an instance selector. */
export interface InstanceElement {
  name: string
  /** The span of the element name. */
  span: SourceSpan
  value: AstNode
}

/**
 * An instance selector (spec "Instance Selector/Object Creation"), e.g.
 * `Coding { system: 'http://loinc.org', code: '8480-6' }`. `Period {:}` has no
 * elements.
 */
export interface InstanceSelectorNode extends BaseNode {
  kind: 'instance'
  type: TypeSpecifier
  elements: InstanceElement[]
}

export type AstNode =
  | NullLiteralNode
  | BooleanLiteralNode
  | StringLiteralNode
  | NumberLiteralNode
  | DateLiteralNode
  | DateTimeLiteralNode
  | TimeLiteralNode
  | QuantityLiteralNode
  | IdentifierNode
  | SpecialVariableNode
  | ExternalConstantNode
  | DotNode
  | IndexerNode
  | FunctionCallNode
  | UnaryNode
  | BinaryNode
  | TypeOpNode
  | InstanceSelectorNode

export type AstNodeKind = AstNode['kind']
