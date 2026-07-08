import '../functions/install.ts'

import { FhirPathSyntaxError, type SourceSpan } from '../errors.ts'
import { describeArity, functions } from '../functions/registry.ts'
import type { ModelProvider } from '../model/provider.ts'
import type { AstNode, TypeSpecifier } from '../parser/ast.ts'
import { parse } from '../parser/parser.ts'
import { FUNCTION_SIGNATURES, type ValueKind, valueKindOfTypeName } from './signatures.ts'

export interface AnalyzerDiagnostic {
  severity: 'error' | 'warning'
  /** Stable rule identifier, e.g. `unknown-element` or `singleton-required`. */
  code: string
  message: string
  span: SourceSpan
}

export interface AnalyzeOptions {
  model?: ModelProvider
  /** Canonical type of the input the expression will run against, e.g. `FHIR.Patient` or `Patient`. */
  inputType?: string
}

/**
 * Inferred static type of a sub-expression: candidate canonical type names plus
 * cardinality. `types: undefined` means unknown — after children()/descendants()/
 * resolve(), external constants, or anything the analyzer cannot see through —
 * and mutes further checks on that branch, exactly as spec §11 prescribes
 * (authors narrow with `as`/`ofType()`).
 */
interface StaticState {
  types: string[] | undefined
  single: boolean
}

const UNKNOWN: StaticState = { types: undefined, single: false }

/**
 * Statically check one expression against the model: spec §11's strict-mode rules
 * (singleton misuse, wrong operand and argument types, incomparable equality)
 * plus unknown elements, functions, arities, and type names.
 */
export function analyzeExpression(expression: string, options?: AnalyzeOptions): AnalyzerDiagnostic[] {
  let ast: AstNode
  try {
    ast = parse(expression)
  } catch (error) {
    /* v8 ignore start -- parse only throws syntax errors */
    if (!(error instanceof FhirPathSyntaxError)) {
      throw error
    }
    /* v8 ignore stop */
    return [{ severity: 'error', code: 'syntax', message: error.message, span: error.span }]
  }
  const analyzer = new Analyzer(options?.model, options?.inputType)
  analyzer.walk(ast, analyzer.rootState())
  return analyzer.diagnostics
}

class Analyzer {
  readonly diagnostics: AnalyzerDiagnostic[] = []
  private readonly model: ModelProvider | undefined
  private readonly inputType: string | undefined
  private readonly frames: StaticState[] = []

  constructor(model: ModelProvider | undefined, inputType: string | undefined) {
    this.model = model
    this.inputType = inputType === undefined ? undefined : (this.model?.resolveType(inputType) ?? inputType)
  }

  rootState(): StaticState {
    return this.inputType === undefined ? UNKNOWN : { types: [this.inputType], single: true }
  }

  walk(node: AstNode, input: StaticState): StaticState {
    switch (node.kind) {
      case 'null':
        // The empty literal `{}` is statically at most one item, so it satisfies
        // singleton operands (`{} + 1`, `{} and true` are spec-legal).
        return { types: [], single: true }
      case 'boolean':
        return { types: ['System.Boolean'], single: true }
      case 'string':
        return { types: ['System.String'], single: true }
      case 'number':
        return {
          types: [node.isLong ? 'System.Long' : node.isDecimal ? 'System.Decimal' : 'System.Integer'],
          single: true,
        }
      case 'date':
        return { types: ['System.Date'], single: true }
      case 'dateTime':
        return { types: ['System.DateTime'], single: true }
      case 'time':
        return { types: ['System.Time'], single: true }
      case 'quantity':
        return { types: ['System.Quantity'], single: true }
      case 'external':
        return UNKNOWN
      case 'special':
        return this.walkSpecial(node.name)
      case 'identifier':
        return this.walkIdentifier(node, input)
      case 'dot':
        return this.walk(node.right, this.walk(node.left, input))
      case 'indexer': {
        const target = this.walk(node.target, input)
        const index = this.walk(node.index, input)
        this.requireKind(index, 'Numeric', node.index.span, 'the indexer expects a single Integer')
        return { types: target.types, single: true }
      }
      case 'call':
        return this.walkCall(node, input)
      case 'unary': {
        const operand = this.walk(node.operand, input)
        this.requireKind(operand, 'Numeric', node.operand.span, `unary '${node.operator}' expects a single number`)
        return operand
      }
      case 'binary':
        return this.walkBinary(node, input)
      case 'typeOp':
        return this.walkTypeOp(node, input)
      /* v8 ignore start -- exhaustiveness guard */
      default: {
        const unreachable: never = node
        throw new Error(`Unhandled node ${String(unreachable)}`)
      }
      /* v8 ignore stop */
    }
  }

  private walkSpecial(name: 'this' | 'index' | 'total'): StaticState {
    if (name === 'this') {
      return this.frames.at(-1) ?? this.rootState()
    }
    return name === 'index' ? { types: ['System.Integer'], single: true } : UNKNOWN
  }

  private walkIdentifier(node: AstNode & { kind: 'identifier' }, input: StaticState): StaticState {
    if (input.types === undefined) {
      // Even with an unknown input, a root identifier naming a model type anchors
      // the state — this is what checks `Patient.nope` without an inputType option.
      const asType = this.model?.resolveType(node.name)
      if (asType !== undefined) {
        return { types: [asType], single: true }
      }
      return UNKNOWN
    }
    // Root rule: an identifier naming the (super)type of the context is the context.
    if (this.model) {
      const asType = this.model.resolveType(node.name)
      if (asType !== undefined && input.types.some(type => this.model?.isSubtypeOf(type, asType))) {
        return input
      }
    }
    const found: string[] = []
    let isCollection = false
    for (const type of input.types) {
      const element = this.model?.getElement(type, node.name)
      if (element) {
        isCollection = isCollection || element.isCollection
        for (const elementType of element.types) {
          found.push(this.canonicalize(elementType))
        }
      }
    }
    if (found.length === 0) {
      if (this.model) {
        const hint = this.isChoiceKeyMisuse(input.types, node.name)
          ? '; choice elements use their stem name'
          : didYouMean(node.name, this.elementNames(input.types))
        this.report(
          'unknown-element',
          `Element '${node.name}' is not defined on ${input.types.join(' | ')}${hint}`,
          node.span
        )
      }
      return UNKNOWN
    }
    return { types: [...new Set(found)], single: input.single && !isCollection }
  }

  private canonicalize(elementType: string): string {
    if (elementType.startsWith('System.')) {
      return elementType
    }
    return this.model?.resolveType(elementType) ?? elementType
  }

  /**
   * True for `valueQuantity`-style keys whose stem is a choice element on one of the
   * input types — the same test the evaluator uses (engine/navigation.ts), so the
   * static diagnostic and the runtime error carry the same guidance.
   */
  private isChoiceKeyMisuse(types: string[], name: string): boolean {
    if (!this.model) {
      return false
    }
    for (const type of types) {
      for (let position = 1; position < name.length; position++) {
        if (!/[A-Z]/.test(name[position] as string)) {
          continue
        }
        const stem = name.slice(0, position)
        if (this.model.getElement(type, stem)?.isChoice === true) {
          return true
        }
      }
    }
    return false
  }

  /** Every element name the input types can offer, for typo suggestions. */
  private elementNames(types: string[]): string[] {
    if (this.model?.listElements === undefined) {
      return []
    }
    const names: string[] = []
    for (const type of types) {
      const elements = this.model.listElements(type)
      if (elements !== undefined) {
        names.push(...elements)
      }
    }
    return names
  }

  private walkCall(node: AstNode & { kind: 'call' }, input: StaticState): StaticState {
    const registered = functions.get(node.name)
    if (!registered) {
      this.report(
        'unknown-function',
        `Unrecognized function '${node.name}'${didYouMean(node.name, functions.keys())}`,
        node.span
      )
      for (const argument of node.args) {
        this.walk(argument, input)
      }
      return UNKNOWN
    }
    if (node.args.length < registered.minArity || node.args.length > registered.maxArity) {
      this.report(
        'wrong-arity',
        `Function '${node.name}' expects ${describeArity(registered.minArity, registered.maxArity)}, got ${node.args.length}`,
        node.span
      )
    }
    const signature = FUNCTION_SIGNATURES[node.name]
    if (!signature) {
      for (const argument of node.args) {
        this.walk(argument, input)
      }
      return UNKNOWN
    }
    if (signature.input) {
      if (signature.input.singleton && input.types !== undefined && !input.single) {
        this.report(
          'singleton-required',
          `${node.name}() expects a single item as input, but this is a collection (spec §11)${NARROW_HINT}`,
          node.span
        )
      }
      if (signature.input.kind) {
        this.requireKind(
          { types: input.types, single: true },
          signature.input.kind,
          node.span,
          `${node.name}() expects a ${signature.input.kind} input`
        )
      }
    }
    node.args.forEach((argument, index) => {
      const spec = signature.args?.[index] ?? signature.args?.at(-1)
      if (spec === 'expression') {
        this.frames.push({ types: input.types, single: true })
        this.walk(argument, { types: input.types, single: true })
        this.frames.pop()
        return
      }
      if (spec === 'type-name') {
        this.checkTypeArgument(node.name, argument)
        return
      }
      // Value arguments evaluate against $this, mirroring the runtime.
      const argState = this.walk(argument, this.frames.at(-1) ?? this.rootState())
      if (spec !== undefined && spec !== 'any') {
        if (argState.types !== undefined && !argState.single) {
          this.report(
            'argument-singleton',
            `${node.name}() expects a single ${spec} argument, but this is a collection (spec §11)${NARROW_HINT}`,
            argument.span
          )
        } else {
          this.requireKind(argState, spec, argument.span, `${node.name}() expects a ${spec} argument`)
        }
      }
    })
    return signature.result(input)
  }

  private checkTypeArgument(functionName: string, argument: AstNode): void {
    const parts = typeSpecifierParts(argument)
    if (parts === undefined) {
      this.report('unknown-type', `${functionName}() expects a type name argument`, argument.span)
      return
    }
    this.checkTypeName(parts, argument.span)
  }

  private checkTypeName(parts: string[], span: SourceSpan): void {
    if (parts.length === 2 && parts[0] === 'System') {
      if (!SYSTEM_TYPE_NAMES.has(parts[1] as string)) {
        this.report('unknown-type', `Unknown type 'System.${parts[1]}'`, span)
      }
      return
    }
    const name = parts.length === 2 ? (parts[1] as string) : (parts[0] as string)
    if (parts.length === 2 && this.model && parts[0] !== this.model.namespace) {
      this.report('unknown-type', `Unknown namespace '${parts[0]}'`, span)
      return
    }
    if (this.model && this.model.resolveType(name) === undefined && !SYSTEM_TYPE_NAMES.has(name)) {
      this.report('unknown-type', `Unknown type '${parts.join('.')}'`, span)
    }
  }

  private walkBinary(node: AstNode & { kind: 'binary' }, input: StaticState): StaticState {
    const left = this.walk(node.left, input)
    const right = this.walk(node.right, input)
    switch (node.operator) {
      case '+':
      case '-':
      case '*':
      case '/':
      case 'div':
      case 'mod': {
        this.checkArithmetic(node.operator, left, right, node.span)
        const numeric = node.operator === '/' ? 'System.Decimal' : undefined
        const types = numeric ? [numeric] : (left.types ?? right.types)
        return { types, single: true }
      }
      case '&':
        this.requireSingle(left, node.left.span, "'&' expects single-item operands")
        this.requireSingle(right, node.right.span, "'&' expects single-item operands")
        this.requireKind(left, 'String', node.left.span, "'&' expects String operands")
        this.requireKind(right, 'String', node.right.span, "'&' expects String operands")
        return { types: ['System.String'], single: true }
      case '<':
      case '>':
      case '<=':
      case '>=':
        this.requireSingle(left, node.left.span, `Operator '${node.operator}' expects single-item operands`)
        this.requireSingle(right, node.right.span, `Operator '${node.operator}' expects single-item operands`)
        this.checkComparable(left, right, node.span)
        return { types: ['System.Boolean'], single: true }
      case '=':
      case '!=':
      case '~':
      case '!~':
        this.checkEquality(left, right, node.span)
        return { types: ['System.Boolean'], single: true }
      case 'and':
      case 'or':
      case 'xor':
      case 'implies': {
        // Any single item satisfies a Boolean operand through the implicit-exists
        // rule, so only cardinality is checkable here.
        this.requireSingle(left, node.left.span, `'${node.operator}' expects single-item operands`)
        this.requireSingle(right, node.right.span, `'${node.operator}' expects single-item operands`)
        return { types: ['System.Boolean'], single: true }
      }
      case '|':
        return {
          types: left.types && right.types ? [...new Set([...left.types, ...right.types])] : undefined,
          single: false,
        }
      case 'in':
      case 'contains': {
        const singletonSide = node.operator === 'in' ? left : right
        const singletonSpan = node.operator === 'in' ? node.left.span : node.right.span
        this.requireSingle(
          singletonSide,
          singletonSpan,
          `The ${node.operator === 'in' ? 'left' : 'right'} operand of '${node.operator}' must be a single item`
        )
        return { types: ['System.Boolean'], single: true }
      }
      /* v8 ignore start -- the parser produces no other binary operators */
      default:
        return UNKNOWN
      /* v8 ignore stop */
    }
  }

  /** Report a singleton violation when the state is statically known to be a collection. */
  private requireSingle(state: StaticState, span: SourceSpan, message: string): void {
    if (isCollection(state)) {
      this.report('singleton-required', `${message}${NARROW_HINT}`, span)
    }
  }

  private walkTypeOp(node: AstNode & { kind: 'typeOp' }, input: StaticState): StaticState {
    const operand = this.walk(node.operand, input)
    this.requireSingle(operand, node.operand.span, `'${node.operator}' expects a single item operand`)
    this.checkTypeName(node.type.parts, node.type.span)
    if (node.operator === 'is') {
      return { types: ['System.Boolean'], single: true }
    }
    return { types: [this.resolveSpecifier(node.type)], single: true }
  }

  private resolveSpecifier(specifier: TypeSpecifier): string {
    const name = specifier.parts.length === 2 ? (specifier.parts[1] as string) : (specifier.parts[0] as string)
    if (specifier.parts[0] === 'System') {
      return `System.${name}`
    }
    return this.model?.resolveType(name) ?? name
  }

  private checkArithmetic(operator: string, left: StaticState, right: StaticState, span: SourceSpan): void {
    if (isCollection(left) || isCollection(right)) {
      this.report('singleton-required', `Operator '${operator}' expects single-item operands${NARROW_HINT}`, span)
      return
    }
    const leftKind = kindOf(left)
    const rightKind = kindOf(right)
    if (leftKind === undefined || rightKind === undefined || leftKind === 'Complex' || rightKind === 'Complex') {
      return
    }
    const scalars: ValueKind[] = ['Numeric', 'Quantity']
    const valid =
      (operator === '+' && leftKind === 'String' && rightKind === 'String') ||
      ((operator === '+' || operator === '-') &&
        ((leftKind === 'Numeric' && rightKind === 'Numeric') ||
          (leftKind === 'Quantity' && rightKind === 'Quantity') ||
          (leftKind === 'Temporal' && rightKind === 'Quantity'))) ||
      ((operator === '*' || operator === '/') && scalars.includes(leftKind) && scalars.includes(rightKind)) ||
      ((operator === 'div' || operator === 'mod') && leftKind === 'Numeric' && rightKind === 'Numeric')
    if (!valid) {
      this.report('operand-type', `Operator '${operator}' is not defined for these operand types`, span)
    }
  }

  private checkComparable(left: StaticState, right: StaticState, span: SourceSpan): void {
    const leftKind = kindOf(left)
    const rightKind = kindOf(right)
    if (leftKind === undefined || rightKind === undefined) {
      return
    }
    if (leftKind === 'Boolean' || rightKind === 'Boolean' || leftKind !== rightKind) {
      this.report('operand-type', 'Comparison operands must be single values of comparable types', span)
    }
  }

  private checkEquality(left: StaticState, right: StaticState, span: SourceSpan): void {
    const leftKind = kindOf(left)
    const rightKind = kindOf(right)
    if (leftKind === undefined || rightKind === undefined || leftKind === 'Complex' || rightKind === 'Complex') {
      return
    }
    if (leftKind !== rightKind) {
      this.report('equality-incompatible', `${leftKind} and ${rightKind} operands can never be equal (spec §11)`, span)
    }
  }

  private requireKind(state: StaticState, kind: ValueKind, span: SourceSpan, message: string): void {
    const actual = kindOf(state)
    if (actual === undefined) {
      return
    }
    const compatible = actual === kind || (kind === 'Numeric' && actual === 'Quantity')
    if (!compatible) {
      this.report('operand-type', `${message}, found ${state.types?.join(' | ') ?? 'unknown'}`, span)
    }
  }

  private report(code: string, message: string, span: SourceSpan): void {
    this.diagnostics.push({ severity: 'error', code, message, span })
  }
}

const SYSTEM_TYPE_NAMES = new Set([
  'Any',
  'Boolean',
  'String',
  'Integer',
  'Long',
  'Decimal',
  'Date',
  'DateTime',
  'Time',
  'Quantity',
])

/** Appended to singleton-misuse messages so the fix is spelled out, not just the rule. */
const NARROW_HINT = ' — narrow it to one item with first(), last(), or single()'

/** Statically known to hold more than one item (types known, not a singleton). */
function isCollection(state: StaticState): boolean {
  return state.types !== undefined && !state.single
}

/** The behavior kind shared by every candidate type, or undefined when mixed/unknown. */
function kindOf(state: StaticState): ValueKind | undefined {
  if (state.types === undefined || state.types.length === 0) {
    return undefined
  }
  let kind: ValueKind | undefined
  for (const type of state.types) {
    const typeKind = valueKindOfTypeName(type)
    if (kind === undefined) {
      kind = typeKind
    } else if (kind !== typeKind) {
      return undefined
    }
  }
  return kind
}

function typeSpecifierParts(node: AstNode): string[] | undefined {
  if (node.kind === 'identifier') {
    return [node.name]
  }
  if (node.kind === 'dot' && node.left.kind === 'identifier' && node.right.kind === 'identifier') {
    return [node.left.name, node.right.name]
  }
  return undefined
}

/**
 * `— did you mean 'X'?` for a mistyped name, or `''` when nothing is close enough.
 * A suggestion only fires within a small edit budget scaled to the name's length,
 * so a genuine typo (`gven` → `given`, `lengthx` → `length`) is caught while an
 * unrelated name (`nope`) stays unsuggested.
 */
function didYouMean(target: string, candidates: Iterable<string>): string {
  // Budget grows with the name: 1 edit for short names (<=4), up to 3 for long ones.
  // Keeps suggestions high-precision — a real typo, not any name that happens to be near.
  const budget = Math.min(3, Math.ceil(target.length / 4))
  let best: string | undefined
  let bestDistance = budget + 1
  for (const candidate of candidates) {
    if (candidate === target) {
      continue
    }
    // Only a strictly better distance matters, so the cap tightens as matches are found.
    const limit = bestDistance - 1
    const distance = boundedEditDistance(target, candidate, limit)
    if (distance <= limit) {
      bestDistance = distance
      best = candidate
      if (bestDistance === 1) {
        break // Unbeatable: distance 0 would mean an exact match, which is skipped.
      }
    }
  }
  return best === undefined ? '' : ` — did you mean '${best}'?`
}

/**
 * Levenshtein distance capped at `limit`: exact when the distance is <= limit,
 * otherwise returns limit + 1. Only the |i - j| <= limit diagonal band of each
 * DP row is computed (cells outside it can never end <= limit), and the scan
 * bails as soon as a whole row exceeds the cap — so a non-match costs
 * O(limit^2) instead of a full O(len(a) * len(b)) table.
 */
function boundedEditDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) {
    return limit + 1
  }
  const previous: number[] = new Array(b.length + 1)
  for (let j = 0; j <= b.length; j++) {
    previous[j] = j
  }
  for (let i = 1; i <= a.length; i++) {
    const from = Math.max(1, i - limit)
    const to = Math.min(b.length, i + limit)
    let diagonal = previous[from - 1] as number
    previous[from - 1] = from === 1 ? i : limit + 1
    let rowBest = previous[from - 1] as number
    for (let j = from; j <= to; j++) {
      // The cell above sits outside the previous row's band when j = i + limit.
      const above = j > i - 1 + limit ? limit + 1 : (previous[j] as number)
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const value = Math.min(above + 1, (previous[j - 1] as number) + 1, diagonal + cost)
      previous[j] = value
      diagonal = above
      if (value < rowBest) {
        rowBest = value
      }
    }
    if (rowBest > limit) {
      return limit + 1
    }
  }
  return Math.min(previous[b.length] as number, limit + 1)
}
