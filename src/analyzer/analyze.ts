import '../functions/install.ts'

import { bareEnvironmentName, BUILTIN_ENV_VARIABLE_NAMES, normalizeEnvKeys } from '../engine/context.ts'
import { FhirPathSyntaxError, type SourceSpan } from '../errors.ts'
import { describeArity, functions } from '../functions/registry.ts'
import type { ElementInfo, ModelProvider } from '../model/provider.ts'
import type { AstNode } from '../parser/ast.ts'
import { parse } from '../parser/parser.ts'
import type { FhirpathTypeDeclarations } from '../typed/infer.ts'
import { commonValueKind, unsatisfiedInput, type ValueKind } from '../values/type-compat.ts'
import { FHIR_PRIMITIVE_TO_SYSTEM, typeLocalName } from '../values/typed-value.ts'
import { analyzerEnvironmentVariables, type AnalyzerVariable } from './declarations.ts'
import { applyOperatorResultRule, applyTypeOperatorResultRule } from './operator-rules.ts'
import { hasNestedUnboundedQuantifier } from './regex-safety.ts'
import {
  applyResultRule,
  type CustomFunctionSignature,
  FUNCTION_SIGNATURES,
  type FunctionSignature,
  type InputSpec,
  singleAnd,
  unionStates,
  withSingle,
} from './signatures.ts'

export interface AnalyzerDiagnostic {
  severity: 'error' | 'warning'
  /** Unresolved element, function, or variable name, when the diagnostic has one. */
  name?: string
  /** Stable rule identifier, e.g. `unknown-element` or `singleton-required`. */
  code: string
  message: string
  span: SourceSpan
}

/** A host variable known to the analyzer. Omit its types to keep the value unknown. */
export type DeclaredVariable = AnalyzerVariable

/** A host function declaration. Arity resolves the call; an optional signature checks it. */
export type SingleDeclaredFunction =
  | {
      minArity?: number
      maxArity?: number
      expression?: never
      signature?: CustomFunctionSignature
      criteria?: never
      envTypes?: never
    }
  | {
      /** The body of an expression-defined CustomFunction; its presence pins the arity to 0. */
      expression: unknown
      minArity?: never
      maxArity?: never
      signature?: CustomFunctionSignature
      criteria?: boolean
      env?: Record<string, unknown>
      envTypes?: FhirpathTypeDeclarations
    }

/** Same-name functions selected by the call focus. Unknown focus keeps only their shared claims. */
export interface OverloadedDeclaredFunction {
  overloads: readonly SingleDeclaredFunction[]
  expression?: never
  minArity?: never
  maxArity?: never
  signature?: never
}

export type DeclaredFunction = SingleDeclaredFunction | OverloadedDeclaredFunction

export interface AnalyzeOptions {
  model?: ModelProvider
  /** Canonical type of the input the expression will run against, e.g. `FHIR.Patient` or `Patient`. */
  inputType?: string
  /** Host-supplied functions by name — EvaluateOptions.functions can be passed as-is. */
  functions?: Record<string, DeclaredFunction>
  /** Host-supplied environment variables by name (with or without the leading `%`). */
  variables?: Record<string, DeclaredVariable>
}

/**
 * Candidate type names and cardinality for one sub-expression. `undefined`
 * means unknown and pauses checks that need that fact. `single` is true for at
 * most one item, false for a possible collection, and undefined when unknown.
 */
interface StaticState {
  types: string[] | undefined
  single: boolean | undefined
  /**
   * Canonical resource types a Reference-valued state may point to (from
   * `Reference.targetProfile`) — what resolve() yields. Carried by element
   * navigation and cardinality-preserving functions; absent means unknown.
   */
  targets?: string[]
  /** True until the raw input has been narrowed or navigated through the model. */
  rawInput?: boolean
}

const UNKNOWN: StaticState = { types: undefined, single: undefined }

/**
 * Variables visible at one point in analysis. Operators and arguments receive a
 * copy. A dynamic variable name prevents later unknown-variable diagnostics in
 * that chain.
 */
interface VariableScope {
  vars: Map<string, StaticState>
  hasDynamic: boolean
}

function emptyScope(): VariableScope {
  return { vars: new Map(), hasDynamic: false }
}

function forkScope(scope: VariableScope): VariableScope {
  return { vars: new Map(scope.vars), hasDynamic: scope.hasDynamic }
}

export interface AnalysisDetails {
  diagnostics: AnalyzerDiagnostic[]
  /**
   * The expression's inferred result: canonical type names and cardinality, the
   * same StaticState the checks run on. `types: undefined` means the analyzer
   * cannot see through the expression (an unknown region), and `single`
   * undefined means the cardinality is unknown — neither is an error. Lets a
   * caller cross-check a declared type against what the expression really
   * yields (see `analyzeDto`).
   */
  result: { types: string[] | undefined; single: boolean | undefined }
  /**
   * `Type.element` paths the expression reads (local type names), deduped in
   * first-visit order — HAPI's `elementDependencies`. Lets callers know which
   * elements an expression depends on, e.g. for change tracking or editors.
   */
  elementDependencies: string[]
}

/** Runtime-known input state used by strict evaluation. Not part of the public analyzer API. */
export interface AnalyzerRoot {
  types: string[] | undefined
  single: boolean | undefined
}

/**
 * Statically check one expression against the model: spec §11's strict-mode rules
 * (singleton misuse, wrong operand and argument types, incomparable equality)
 * plus unknown elements, functions, arities, type names, and variables.
 * See: https://hl7.org/fhirpath/en/index.html#type-safety-and-strict-evaluation
 */
export function analyzeExpression(expression: string, options?: AnalyzeOptions): AnalyzerDiagnostic[] {
  return analyzeExpressionDetailed(expression, options).diagnostics
}

/**
 * Analyzes one source site with only facts visible in that file. A declared root
 * does not prove which variables the later call provides. DTO sites may also
 * receive variables and functions from base classes, other modules, or
 * `project()`. Such sites omit unknown-variable diagnostics and report an
 * unknown function only when it resembles a local column. A DTO without a known
 * root receives syntax checks only. Use `analyzeDto` when the class and engine
 * are loaded.
 */
export function analyzeSite(
  site: {
    expression: string
    inputType?: string
    dto?: true
    /** Functions the site's file declares — a DTO's `@column` fields (see `columnFunctionDeclaration`). */
    functions?: Readonly<Record<string, DeclaredFunction>>
  },
  options?: AnalyzeOptions
): AnalyzerDiagnostic[] {
  const declared = { ...site.functions, ...options?.functions }
  const merged: AnalyzeOptions = {
    ...options,
    ...(site.inputType !== undefined && { inputType: site.inputType }),
    ...(Object.keys(declared).length > 0 && { functions: declared }),
  }
  const diagnostics = analyzeExpression(site.expression, merged)
  if (site.dto !== true) {
    return site.inputType === undefined
      ? diagnostics
      : diagnostics.filter(diagnostic => diagnostic.code !== 'unknown-variable')
  }
  if (site.inputType === undefined) {
    return diagnostics.filter(diagnostic => diagnostic.code === 'syntax')
  }
  const columns = Object.keys(site.functions ?? {})
  return diagnostics.filter(diagnostic => {
    if (diagnostic.code === 'unknown-variable') {
      return false
    }
    if (diagnostic.code !== 'unknown-function') {
      return true
    }
    return diagnostic.name !== undefined && nearestName(diagnostic.name, columns) !== undefined
  })
}

/** `analyzeExpression` plus the element paths the expression touches and its inferred result type. */
export function analyzeExpressionDetailed(expression: string, options?: AnalyzeOptions): AnalysisDetails {
  let ast: AstNode
  try {
    ast = parse(expression)
  } catch (error) {
    /* v8 ignore start -- parse only throws syntax errors */
    if (!(error instanceof FhirPathSyntaxError)) {
      throw error
    }
    /* v8 ignore stop */
    return {
      diagnostics: [{ severity: 'error', code: 'syntax', message: error.message, span: error.span }],
      elementDependencies: [],
      result: { types: undefined, single: undefined },
    }
  }
  return analyzeAstDetailed(ast, options)
}

/** Analyze an already parsed expression, optionally with a runtime-derived input state. */
export function analyzeAstDetailed(
  ast: AstNode,
  options?: AnalyzeOptions,
  root?: AnalyzerRoot,
  includeExpressionDiagnostics = false
): AnalysisDetails {
  const analyzer = new Analyzer(options, root, includeExpressionDiagnostics)
  const state = analyzer.walk(ast, analyzer.rootState(), emptyScope())
  return {
    diagnostics: analyzer.diagnostics,
    elementDependencies: [...analyzer.dependencies],
    result: { types: state.types, single: state.single },
  }
}

class Analyzer {
  readonly diagnostics: AnalyzerDiagnostic[] = []
  readonly dependencies = new Set<string>()
  private readonly model: ModelProvider | undefined
  private readonly root: AnalyzerRoot
  private readonly includeExpressionDiagnostics: boolean
  private readonly frames: StaticState[] = []
  /** Every declaration of each host-supplied name; one entry unless the name is overloaded. */
  private readonly customFunctions: ReadonlyMap<string, readonly ResolvedDeclaration[]>
  private readonly declaredVariables: ReadonlyMap<string, DeclaredVariable>
  private readonly activeExpressionFunctions = new Set<string>()

  constructor(
    options: AnalyzeOptions | undefined,
    root: AnalyzerRoot | undefined,
    includeExpressionDiagnostics: boolean
  ) {
    this.model = options?.model
    this.includeExpressionDiagnostics = includeExpressionDiagnostics
    const inputType = options?.inputType
    this.root =
      root ??
      (inputType === undefined
        ? { types: undefined, single: undefined }
        : { types: [this.model?.resolveType(inputType) ?? inputType], single: true })
    this.customFunctions = new Map(
      Object.entries(options?.functions ?? {}).map(([name, declared]) => [
        name,
        ('overloads' in declared ? declared.overloads : [declared]).map(declaration =>
          resolvedDeclaration(declaration, this.model)
        ),
      ])
    )
    this.declaredVariables = new Map(Object.entries(normalizeEnvKeys(options?.variables)))
  }

  rootState(): StaticState {
    return this.root.types === undefined
      ? { ...UNKNOWN }
      : { types: this.root.types, single: this.root.single, rawInput: true }
  }

  walk(node: AstNode, input: StaticState, scope: VariableScope): StaticState {
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
        return this.walkExternal(node, scope)
      case 'special':
        return this.walkSpecial(node.name)
      case 'identifier':
        return this.walkIdentifier(node, input)
      case 'dot':
        // One scope threads the whole chain, so defineVariable() in an earlier
        // link is visible to later links — exactly like the runtime.
        return this.walk(node.right, this.walk(node.left, input, scope), scope)
      case 'indexer': {
        const target = this.walk(node.target, input, scope)
        const index = this.walk(node.index, input, scope)
        this.requireKind(index, 'Numeric', node.index.span, 'the indexer expects a single Integer')
        return withSingle(target, true)
      }
      case 'call':
        return this.walkCall(node, input, scope)
      case 'unary': {
        const operand = this.walk(node.operand, input, scope)
        this.requireKind(operand, 'Numeric', node.operand.span, `unary '${node.operator}' expects a single number`)
        return operand
      }
      case 'binary':
        return this.walkBinary(node, input, scope)
      case 'typeOp':
        return this.walkTypeOp(node, input, scope)
      /* v8 ignore start -- exhaustive fallback */
      default: {
        const unreachable: never = node
        throw new Error(`Unhandled node ${String(unreachable)}`)
      }
      /* v8 ignore stop */
    }
  }

  /**
   * `%name`: defineVariable() bindings and built-in variables resolve with their
   * known state; anything else is an undefined variable (spec §9), the same
   * check the runtime applies. Host-supplied variables must be declared to the
   * analyzer (AnalyzeOptions is the place this will grow).
   */
  private walkExternal(node: AstNode & { kind: 'external' }, scope: VariableScope): StaticState {
    const defined = scope.vars.get(node.name)
    if (defined !== undefined) {
      return defined
    }
    const declared = this.declaredVariables.get(node.name)
    if (declared !== undefined) {
      return this.declaredVariableState(declared)
    }
    switch (node.name) {
      case 'context':
      case 'resource':
      case 'rootResource':
        // Contained-resource re-rooting is a later refinement, mirroring the runtime.
        return this.rootState()
      case 'ucum':
      case 'sct':
      case 'loinc':
        return { types: ['System.String'], single: true }
      default:
        break
    }
    // FHIR-defined families expand to HL7 urls: %`vs-[name]`, %`ext-[name]`.
    if (node.name.startsWith('vs-') || node.name.startsWith('ext-')) {
      return { types: ['System.String'], single: true }
    }
    // A dynamically-named defineVariable() earlier in the chain may have bound
    // this name, so reporting it as undefined could be wrong — stay quiet.
    if (!scope.hasDynamic) {
      this.report('unknown-variable', `Undefined environment variable %${node.name}`, node.span, 'error', node.name)
    }
    return UNKNOWN
  }

  private walkSpecial(name: 'this' | 'index' | 'total'): StaticState {
    if (name === 'this') {
      return this.frames.at(-1) ?? this.rootState()
    }
    return name === 'index' ? { types: ['System.Integer'], single: true } : UNKNOWN
  }

  /**
   * A quantity's components (spec §4: `value` and `unit`), the one System type
   * with navigable elements. The runtime reads them off the quantity's raw
   * `{ value, unit }` shape (a `toQuantity()` result, a quantity literal), so
   * the analyzer must know them too or flag working navigation.
   */
  private static readonly SYSTEM_QUANTITY_ELEMENTS: ReadonlyMap<string, ElementInfo> = new Map([
    ['value', { types: ['System.Decimal'], isCollection: false, isChoice: false }],
    ['unit', { types: ['System.String'], isCollection: false, isChoice: false }],
  ])

  private walkIdentifier(node: AstNode & { kind: 'identifier' }, input: StaticState): StaticState {
    // Navigating from a statically empty input yields empty — nothing to check.
    if (input.types !== undefined && input.types.length === 0) {
      return { types: [], single: true }
    }
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
      let matchingTypes: string[] = []
      if (asType !== undefined) {
        const requiredType: string = asType
        matchingTypes = input.types.filter(type => this.model?.isSubtypeOf(type, requiredType) === true)
      }
      if (asType !== undefined && matchingTypes.length > 0) {
        // The runtime matches a type name against the raw input only through the
        // resourceType discriminator (values/typed-value.ts), so a non-resource
        // name never matches there and the whole path navigates to empty.
        if (input.rawInput === true && !this.isResourceType(asType)) {
          this.report(
            'datatype-root',
            `'${node.name}' is not a resource type, and a type-name root matches only a resource's resourceType, so this always evaluates to empty — navigate from the input with a relative path`,
            node.span
          )
        }
        return { ...input, types: matchingTypes }
      }
    }
    const found: string[] = []
    let isCollection = false
    // Reference targets (Reference.targetProfile) accumulate so a later
    // resolve() yields their union; one unconstrained reference makes the
    // whole set unknown.
    let targets: string[] | undefined = []
    for (const type of input.types) {
      const element =
        type === 'System.Quantity'
          ? Analyzer.SYSTEM_QUANTITY_ELEMENTS.get(node.name)
          : this.model?.getElement(type, node.name)
      if (element) {
        // elementDependencies names model elements; System.Quantity's components
        // are not ones (there is no FHIR `Quantity.value` dependency here).
        if (!type.startsWith('System.')) {
          this.dependencies.add(`${typeLocalName(type)}.${node.name}`)
        }
        isCollection = isCollection || element.isCollection
        for (const elementType of element.types) {
          found.push(this.canonicalize(elementType))
        }
        if (element.types.some(elementType => typeLocalName(elementType) === 'Reference')) {
          targets = this.mergeTargets(targets, element)
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
          node.span,
          'error',
          node.name
        )
      }
      return UNKNOWN
    }
    const state: StaticState = { types: [...new Set(found)], single: singleAnd(input.single, !isCollection) }
    if (targets !== undefined && targets.length > 0) {
      state.targets = [...new Set(targets)]
    }
    return state
  }

  /**
   * True when `canonical` is the model's Resource base or derives from it —
   * the types whose instances carry a resourceType discriminator. A model
   * without a Resource base cannot make the distinction, so the check stays
   * permissive there.
   */
  private isResourceType(canonical: string): boolean {
    const base = this.model?.resolveType('Resource')
    return base === undefined || this.model?.isSubtypeOf(canonical, base) === true
  }

  private canonicalize(elementType: string): string {
    if (elementType.startsWith('System.')) {
      return elementType
    }
    return this.model?.resolveType(elementType) ?? elementType
  }

  /**
   * A Reference-typed element's targets folded into the accumulated set.
   * One unconstrained reference makes the whole set unknown, and unknown
   * stays unknown; otherwise the result is the canonicalized union.
   */
  private mergeTargets(current: string[] | undefined, element: ElementInfo): string[] | undefined {
    if (current === undefined || element.referenceTargets === undefined) {
      return undefined
    }
    return [...current, ...element.referenceTargets.map(target => this.canonicalize(target))]
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

  /**
   * A call: resolve the function (built-ins first — EvaluateOptions.functions
   * cannot override them either), then hand each concern to its own step:
   * arity, input shape, arguments, per-function effects, result.
   */
  private walkCall(node: AstNode & { kind: 'call' }, input: StaticState, scope: VariableScope): StaticState {
    const registered = functions.get(node.name)
    const custom = registered === undefined ? this.declarationFor(node.name, input) : undefined
    const resolved = registered ?? custom
    if (resolved === undefined) {
      this.report(
        'unknown-function',
        `Unrecognized function '${node.name}'${didYouMean(node.name, [...functions.keys(), ...this.customFunctions.keys()])}`,
        node.span,
        'error',
        node.name
      )
      this.walkUncheckedArguments(node, input, scope)
      return UNKNOWN
    }
    this.checkArity(node, resolved)
    const signature = registered !== undefined ? FUNCTION_SIGNATURES[node.name] : this.toSignature(custom?.signature)
    if (!signature) {
      this.walkUncheckedArguments(node, input, scope)
      return this.expressionFunctionResult(node.name, custom, input, scope) ?? UNKNOWN
    }
    this.checkCallInput(node, signature, input)
    const { argStates, typeTarget } = this.walkArguments(node, signature, input, scope)
    if (node.name === 'defineVariable') {
      this.registerVariable(node, input, argStates, scope)
    }
    this.checkRegexPattern(node)
    // ofType(X) filters and as(X) casts: both narrow to the named type,
    // intersected with the known candidates.
    if ((node.name === 'ofType' || node.name === 'as') && typeTarget !== undefined) {
      return { types: this.narrowTypes(input, typeTarget, node.span), single: input.single }
    }
    const expressionResult = this.expressionFunctionResult(node.name, custom, input, scope)
    if (expressionResult !== undefined) {
      return expressionResult
    }
    return applyResultRule(signature.result, input, argStates)
  }

  /** Apply the expression-body and criteria rules in one place for signed and unsigned declarations. */
  private expressionFunctionResult(
    name: string,
    declaration: ResolvedDeclaration | undefined,
    input: StaticState,
    scope: VariableScope
  ): StaticState | undefined {
    if (declaration?.expression === undefined) {
      return undefined
    }
    const expression = declaration.expression
    if (declaration.criteria === true) {
      this.walkExpressionFunction(name, expression, declaration.variables, input, scope)
      return { types: ['System.Boolean'], single: true }
    }
    if (declaration.signature?.result === undefined) {
      return this.walkExpressionFunction(name, expression, declaration.variables, input, scope)
    }
    if (this.includeExpressionDiagnostics) {
      this.walkExpressionFunction(name, expression, declaration.variables, input, scope)
    }
    return undefined
  }

  /** Infer a literal expression-function body under its call focus and temporary local environment declarations. */
  private walkExpressionFunction(
    name: string,
    expression: NonNullable<ResolvedDeclaration['expression']>,
    variables: ResolvedDeclaration['variables'],
    input: StaticState,
    callerScope: VariableScope
  ): StaticState {
    if (this.activeExpressionFunctions.has(name)) {
      return UNKNOWN
    }
    let ast = expression.ast
    if (ast === undefined) {
      try {
        ast = parse(expression.source)
      } catch {
        return UNKNOWN
      }
    }
    const functionScope = forkScope(callerScope)
    for (const [declaredName, variable] of Object.entries(variables ?? {})) {
      const bare = bareEnvironmentName(declaredName)
      // defineVariable() values have priority over environment overlays at runtime.
      if (!functionScope.vars.has(bare)) {
        functionScope.vars.set(bare, this.declaredVariableState(variable))
      }
    }
    const diagnosticCount = this.diagnostics.length
    this.activeExpressionFunctions.add(name)
    this.frames.push(input)
    try {
      return this.walk(ast, input, functionScope)
    } finally {
      if (this.includeExpressionDiagnostics) {
        for (const diagnostic of this.diagnostics.slice(diagnosticCount)) {
          diagnostic.message = `Custom function '${name}': ${diagnostic.message}`
        }
      } else {
        // Body spans index another source string, so callers cannot display these diagnostics correctly.
        this.diagnostics.length = diagnosticCount
      }
      this.frames.pop()
      this.activeExpressionFunctions.delete(name)
    }
  }

  /** Convert one declared environment value into the same state used for scoped variables. */
  private declaredVariableState(declared: DeclaredVariable): StaticState {
    return {
      types: declared.types?.map(type => this.canonicalize(type)),
      single: declared.single,
      ...(declared.targets !== undefined && { targets: declared.targets.map(type => this.canonicalize(type)) }),
    }
  }

  /**
   * Selects a host declaration from the focus. One match keeps its full
   * signature. Several matches are merged conservatively. No match merges their
   * input types so `checkCallInput` can report one error.
   */
  private declarationFor(name: string, input: StaticState): ResolvedDeclaration | undefined {
    const candidates = this.customFunctions.get(name)
    if (candidates === undefined || candidates.length <= 1) {
      return candidates?.[0]
    }
    const focus = input.types ?? []
    const fitting = candidates.filter(
      candidate => unsatisfiedInput(this.model, candidate.signature?.input?.types, focus) === undefined
    )
    return fitting.length === 1 ? fitting[0] : mergedDeclaration(fitting.length === 0 ? candidates : fitting)
  }

  /** Without a signature the arguments still walk (for their own diagnostics), each in a scope fork. */
  private walkUncheckedArguments(node: AstNode & { kind: 'call' }, input: StaticState, scope: VariableScope): void {
    for (const argument of node.args) {
      this.walk(argument, input, forkScope(scope))
    }
  }

  private checkArity(node: AstNode & { kind: 'call' }, arity: { minArity?: number; maxArity?: number }): void {
    const minArity = arity.minArity ?? 0
    const maxArity = arity.maxArity ?? Number.POSITIVE_INFINITY
    if (node.args.length < minArity || node.args.length > maxArity) {
      this.report(
        'wrong-arity',
        `Function '${node.name}' expects ${describeArity(minArity, maxArity)}, got ${node.args.length}`,
        node.span
      )
    }
  }

  /** The signature's input constraints: cardinality, value kind, and declared types. */
  private checkCallInput(node: AstNode & { kind: 'call' }, signature: FunctionSignature, input: StaticState): void {
    if (!signature.input) {
      return
    }
    // A function written for one type (a DTO's `@column`), called on a focus
    // that can never be that type. `unsatisfiedInput` holds the same rule the
    // engine applies, so the two halves agree on what counts as a mistake.
    const unsatisfied =
      input.types === undefined ? undefined : unsatisfiedInput(this.model, signature.input.types, input.types)
    if (unsatisfied !== undefined) {
      this.report(
        'input-type',
        `${node.name}() expects ${unsatisfied.wanted.join(' | ')} as input, found ${unsatisfied.found.join(' | ')}`,
        node.span
      )
    }
    if (signature.input.singleton && input.types !== undefined && input.single === false) {
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

  /**
   * Walk every argument per its spec — lambdas against a $this frame,
   * type names against the model, values against $this — collecting the
   * analyzed state per position (undefined for type-name positions). Each
   * argument gets its own scope copy, like the runtime's per-argument fork.
   */
  private walkArguments(
    node: AstNode & { kind: 'call' },
    signature: FunctionSignature,
    input: StaticState,
    scope: VariableScope
  ): { argStates: (StaticState | undefined)[]; typeTarget: string | undefined } {
    const argStates: (StaticState | undefined)[] = []
    let typeTarget: string | undefined
    node.args.forEach((argument, index) => {
      const spec = signature.args?.[index] ?? signature.args?.at(-1)
      if (spec === 'expression' || spec === 'condition' || spec === 'sort-key') {
        // A top-level unary '-' on a sort key marks descending order (any type),
        // mirroring how sort() reads the AST; only the key itself is analyzed.
        const body =
          spec === 'sort-key' && argument.kind === 'unary' && argument.operator === '-' ? argument.operand : argument
        // $this is one item of the input — same candidates and reference targets.
        const itemState = withSingle(input, true)
        this.frames.push(itemState)
        const state = this.walk(body, itemState, forkScope(scope))
        this.frames.pop()
        argStates.push(state)
        if (spec === 'condition') {
          this.requireSingle(state, argument.span, `${node.name}() expects a single Boolean criterion`)
          if (!isCollection(state)) {
            this.requireKind(state, 'Boolean', argument.span, `${node.name}() expects a Boolean criterion`)
          }
        }
        return
      }
      if (spec === 'type-name') {
        argStates.push(undefined)
        const resolved = this.checkTypeArgument(node.name, argument)
        if (index === 0) {
          typeTarget = resolved
        }
        return
      }
      // Value arguments evaluate against $this, mirroring the runtime.
      const argState = this.walk(argument, this.frames.at(-1) ?? this.rootState(), forkScope(scope))
      argStates.push(argState)
      if (spec !== undefined && spec !== 'any') {
        if (argState.types !== undefined && argState.single === false) {
          this.report(
            'argument-singleton',
            `${node.name}() expects a single ${spec} argument, but this is a collection (spec §11)${NARROW_HINT}`,
            argument.span,
            'warning'
          )
        } else {
          this.requireKind(argState, spec, argument.span, `${node.name}() expects a ${spec} argument`)
        }
      }
    })
    return { argStates, typeTarget }
  }

  /**
   * The matches() family compiles its pattern with the backtracking JS RegExp,
   * which cannot be timed out — flag exponential-shaped literal patterns.
   */
  private checkRegexPattern(node: AstNode & { kind: 'call' }): void {
    if (!REGEX_PATTERN_FUNCTIONS.has(node.name)) {
      return
    }
    const pattern = node.args[0]
    if (pattern?.kind === 'string' && hasNestedUnboundedQuantifier(pattern.value)) {
      this.report(
        'regex-backtracking',
        `The regular expression nests unbounded repetition, which can backtrack catastrophically on non-matching input (ReDoS); rewrite it or supply a linear-time engine via EvaluateOptions.regex`,
        pattern.span,
        'warning'
      )
    }
  }

  /**
   * Track a defineVariable() binding in the chain's scope, with the same two
   * rules the runtime enforces: no overriding environment variables, no
   * redefining a name already in scope. Dynamic names cannot be tracked.
   */
  private registerVariable(
    node: AstNode & { kind: 'call' },
    input: StaticState,
    argStates: (StaticState | undefined)[],
    scope: VariableScope
  ): void {
    const nameNode = node.args[0]
    if (nameNode === undefined || nameNode.kind !== 'string') {
      scope.hasDynamic = true
      return
    }
    const name = nameNode.value
    if (BUILTIN_ENV_VARIABLE_NAMES.has(name) || this.declaredVariables.has(name)) {
      this.report('variable-override', `Cannot override the environment variable %${name}`, nameNode.span)
      return
    }
    if (scope.vars.has(name)) {
      this.report('variable-redefined', `Variable %${name} is already defined in this scope`, nameNode.span)
      return
    }
    // Without a value expression the variable holds the function's input.
    scope.vars.set(name, argStates[1] ?? input)
  }

  /**
   * Converts a host function's declared signature into the analyzer's internal
   * shape. Result type names canonicalize once here, and a missing result stays
   * unknown. The input passes through as declared, because `unsatisfiedInput`
   * canonicalizes the names it compares, so a local name such as
   * 'CodeableConcept' works without a second pass.
   */
  private toSignature(declared: CustomFunctionSignature | undefined): FunctionSignature | undefined {
    if (declared === undefined) {
      return undefined
    }
    const types = declared.result?.types?.map(type => this.canonicalize(type))
    const single = declared.result?.single
    return {
      ...(declared.input !== undefined && { input: declared.input }),
      ...(declared.args !== undefined && { args: declared.args }),
      result: {
        kind: 'fixed',
        ...(types !== undefined && { types }),
        ...(single !== undefined && { single }),
      },
    }
  }

  /**
   * The candidate types that survive narrowing to `target`: subtypes of the
   * target pass through unchanged, supertypes narrow to the target itself.
   * Warns when no candidate can ever match — the result is provably empty.
   */
  private narrowTypes(input: StaticState, target: string, span: SourceSpan): string[] | undefined {
    if (input.types === undefined) {
      return [target]
    }
    const survivors = new Set<string>()
    for (const type of input.types) {
      if (this.isTypeCompatible(type, target)) {
        survivors.add(type)
      } else if (this.isTypeCompatible(target, type)) {
        survivors.add(target)
      }
    }
    if (survivors.size === 0 && input.types.length > 0) {
      this.report(
        'always-empty',
        `No candidate type (${input.types.join(' | ')}) can be a ${target}, so this is always empty`,
        span,
        'warning'
      )
    }
    return [...survivors]
  }

  /** True when every `type` value is a `base` value, including FHIR-primitive → System subtyping. */
  private isTypeCompatible(type: string, base: string): boolean {
    if (type === base || this.model?.isSubtypeOf(type, base) === true) {
      return true
    }
    return base.startsWith('System.') && FHIR_PRIMITIVE_TO_SYSTEM[typeLocalName(type)] === base
  }

  /** Check a type-name argument; returns its canonical name, or undefined when unknown. */
  private checkTypeArgument(functionName: string, argument: AstNode): string | undefined {
    const parts = typeSpecifierParts(argument)
    if (parts === undefined) {
      this.report('unknown-type', `${functionName}() expects a type name argument`, argument.span)
      return undefined
    }
    return this.checkTypeName(parts, argument.span)
  }

  /** Check a type name; returns its canonical form, or undefined when it was reported unknown. */
  private checkTypeName(parts: string[], span: SourceSpan): string | undefined {
    if (parts.length === 2 && parts[0] === 'System') {
      if (!SYSTEM_TYPE_NAMES.has(parts[1] as string)) {
        this.report('unknown-type', `Unknown type 'System.${parts[1]}'`, span)
        return undefined
      }
      return `System.${parts[1]}`
    }
    const name = parts.length === 2 ? (parts[1] as string) : (parts[0] as string)
    if (parts.length === 2 && this.model && parts[0] !== this.model.namespace) {
      this.report('unknown-type', `Unknown namespace '${parts[0]}'`, span)
      return undefined
    }
    const resolved = this.model?.resolveType(name)
    if (this.model && resolved === undefined && !SYSTEM_TYPE_NAMES.has(name)) {
      this.report('unknown-type', `Unknown type '${parts.join('.')}'`, span)
      return undefined
    }
    return resolved ?? (SYSTEM_TYPE_NAMES.has(name) ? `System.${name}` : name)
  }

  private walkBinary(node: AstNode & { kind: 'binary' }, input: StaticState, scope: VariableScope): StaticState {
    // Operator operands are separate chains: each analyzes against its own scope
    // copy, so defineVariable() in one side is invisible to the other, exactly
    // like the runtime.
    const left = this.walk(node.left, input, forkScope(scope))
    const right = this.walk(node.right, input, forkScope(scope))
    switch (node.operator) {
      case '+':
      case '-':
      case '*':
      case '/':
      case 'div':
      case 'mod': {
        this.checkArithmetic(node.operator, left, right, node.span)
        return applyOperatorResultRule(node.operator, left, right)
      }
      case '&':
        this.requireSingle(left, node.left.span, "'&' expects single-item operands")
        this.requireSingle(right, node.right.span, "'&' expects single-item operands")
        this.requireKind(left, 'String', node.left.span, "'&' expects String operands")
        this.requireKind(right, 'String', node.right.span, "'&' expects String operands")
        return applyOperatorResultRule(node.operator, left, right)
      case '<':
      case '>':
      case '<=':
      case '>=':
        this.requireSingle(left, node.left.span, `Operator '${node.operator}' expects single-item operands`)
        this.requireSingle(right, node.right.span, `Operator '${node.operator}' expects single-item operands`)
        this.checkComparable(left, right, node.span)
        return applyOperatorResultRule(node.operator, left, right)
      case '=':
      case '!=':
      case '~':
      case '!~':
        this.checkEquality(left, right, node.span)
        return applyOperatorResultRule(node.operator, left, right)
      case 'and':
      case 'or':
      case 'xor':
      case 'implies': {
        // Any single item satisfies a Boolean operand through the implicit-exists
        // rule, so only cardinality is checkable here.
        this.requireSingle(left, node.left.span, `'${node.operator}' expects single-item operands`)
        this.requireSingle(right, node.right.span, `'${node.operator}' expects single-item operands`)
        return applyOperatorResultRule(node.operator, left, right)
      }
      case '|': {
        return applyOperatorResultRule(node.operator, left, right)
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
        return applyOperatorResultRule(node.operator, left, right)
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

  private walkTypeOp(node: AstNode & { kind: 'typeOp' }, input: StaticState, scope: VariableScope): StaticState {
    const operand = this.walk(node.operand, input, scope)
    this.requireSingle(operand, node.operand.span, `'${node.operator}' expects a single item operand`)
    const resolved = this.checkTypeName(node.type.parts, node.type.span)
    const narrowed =
      node.operator === 'as' && resolved !== undefined ? this.narrowTypes(operand, resolved, node.span) : undefined
    return applyTypeOperatorResultRule(node.operator, narrowed)
  }

  private checkArithmetic(operator: string, left: StaticState, right: StaticState, span: SourceSpan): void {
    if (isCollection(left) || isCollection(right)) {
      this.report('singleton-required', `Operator '${operator}' expects single-item operands${NARROW_HINT}`, span)
      return
    }
    const leftKind = commonValueKind(left.types)
    const rightKind = commonValueKind(right.types)
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
    const leftKind = commonValueKind(left.types)
    const rightKind = commonValueKind(right.types)
    if (leftKind === undefined || rightKind === undefined) {
      return
    }
    if (leftKind === 'Boolean' || rightKind === 'Boolean' || leftKind !== rightKind) {
      this.report('operand-type', 'Comparison operands must be single values of comparable types', span)
    }
  }

  private checkEquality(left: StaticState, right: StaticState, span: SourceSpan): void {
    const leftKind = commonValueKind(left.types)
    const rightKind = commonValueKind(right.types)
    if (leftKind === undefined || rightKind === undefined || leftKind === 'Complex' || rightKind === 'Complex') {
      return
    }
    if (leftKind !== rightKind) {
      this.report('equality-incompatible', `${leftKind} and ${rightKind} operands can never be equal (spec §11)`, span)
    }
  }

  private requireKind(state: StaticState, kind: ValueKind, span: SourceSpan, message: string): void {
    const actual = commonValueKind(state.types)
    if (actual === undefined) {
      return
    }
    const compatible = actual === kind || (kind === 'Numeric' && actual === 'Quantity')
    if (!compatible) {
      this.report('operand-type', `${message}, found ${state.types?.join(' | ') ?? 'unknown'}`, span)
    }
  }

  private report(
    code: string,
    message: string,
    span: SourceSpan,
    severity: 'error' | 'warning' = 'error',
    name?: string
  ): void {
    this.diagnostics.push({ severity, code, message, span, ...(name !== undefined && { name }) })
  }
}

/** Functions whose first argument is a regular expression pattern. */
const REGEX_PATTERN_FUNCTIONS = new Set(['matches', 'matchesFull', 'replaceMatches'])

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

/** Statically known to possibly hold more than one item (types known, not a singleton). */
function isCollection(state: StaticState): boolean {
  return state.types !== undefined && state.single === false
}

/**
 * A host-supplied declaration as the analyzer uses it: arity and signature,
 * with an expression body's implicit zero arity already spelled out.
 */
interface ResolvedDeclaration {
  minArity?: number
  maxArity?: number
  signature?: CustomFunctionSignature
  expression?: { source: string; ast?: AstNode }
  criteria?: boolean
  variables?: Readonly<Record<string, DeclaredVariable>>
}

function resolvedDeclaration(declared: SingleDeclaredFunction, model: ModelProvider | undefined): ResolvedDeclaration {
  if (declared.expression === undefined) {
    return {
      ...(declared.minArity !== undefined && { minArity: declared.minArity }),
      ...(declared.maxArity !== undefined && { maxArity: declared.maxArity }),
      ...(declared.signature !== undefined && { signature: declared.signature }),
    }
  }
  // An expression-defined function takes no arguments, which is how the runtime
  // calls it (`evaluateHostFunction`).
  const expression = resolvedExpression(declared.expression)
  return {
    minArity: 0,
    maxArity: 0,
    ...(declared.signature !== undefined && { signature: declared.signature }),
    ...(expression !== undefined && { expression }),
    ...(declared.criteria !== undefined && { criteria: declared.criteria }),
    ...((declared.env !== undefined || declared.envTypes !== undefined) && {
      variables: analyzerEnvironmentVariables(declared.env, declared.envTypes, model),
    }),
  }
}

function resolvedExpression(expression: unknown): { source: string; ast?: AstNode } | undefined {
  if (typeof expression === 'string') {
    return { source: expression }
  }
  const compiled = expression as { source?: unknown; ast?: unknown } | undefined
  if (typeof compiled?.source !== 'string') {
    return undefined
  }
  return {
    source: compiled.source,
    ...(compiled.ast !== undefined && { ast: compiled.ast as AstNode }),
  }
}

/**
 * What several declarations of one name say together, for a call none of them
 * answers alone. Everything here widens: the arities span all of them, the
 * input is every type any of them accepts, and the result is the union of
 * theirs — unknown as soon as one declaration leaves it unknown. Arguments are
 * dropped, since checking them against the wrong declaration would report valid
 * code.
 */
function mergedDeclaration(candidates: readonly ResolvedDeclaration[]): ResolvedDeclaration {
  const maxArity = Math.max(...candidates.map(candidate => candidate.maxArity ?? Number.POSITIVE_INFINITY))
  const input = mergedInput(candidates)
  const result = mergedResult(candidates)
  return {
    minArity: Math.min(...candidates.map(candidate => candidate.minArity ?? 0)),
    ...(Number.isFinite(maxArity) && { maxArity }),
    ...((input !== undefined || result !== undefined) && {
      signature: { ...(input !== undefined && { input }), ...(result !== undefined && { result }) },
    }),
  }
}

/** Every type any declaration accepts, or undefined when one of them accepts anything. */
function mergedInput(candidates: readonly ResolvedDeclaration[]): InputSpec | undefined {
  const declared = candidates.map(candidate => candidate.signature?.input?.types)
  if (declared.some(types => types === undefined)) {
    return undefined
  }
  return { types: [...new Set(declared.flatMap(types => types ?? []))] }
}

/** The union of the declarations' results, unknown as soon as one of them is. */
function mergedResult(candidates: readonly ResolvedDeclaration[]): { types?: string[]; single?: boolean } | undefined {
  const union = unionStates(
    candidates.map(candidate => ({
      types: candidate.signature?.result?.types === undefined ? undefined : [...candidate.signature.result.types],
      single: candidate.signature?.result?.single,
    }))
  )
  if (union.types === undefined && union.single === undefined) {
    return undefined
  }
  return {
    ...(union.types !== undefined && { types: union.types }),
    ...(union.single !== undefined && { single: union.single }),
  }
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
 */
function didYouMean(target: string, candidates: Iterable<string>): string {
  const nearest = nearestName(target, candidates)
  return nearest === undefined ? '' : ` — did you mean '${nearest}'?`
}

/**
 * The candidate `target` most plausibly misspells, or undefined when none is
 * close enough: a small edit budget scaled to the name's length, so a genuine
 * typo (`gven` → `given`, `lengthx` → `length`) matches while an unrelated name
 * (`nope`) does not. Both the `did you mean` suggestions and `analyzeSite`
 * weighing an unresolved column name go through here, so one budget decides what
 * counts as a plausible misspelling.
 */
function nearestName(target: string, candidates: Iterable<string>): string | undefined {
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
  return best
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
