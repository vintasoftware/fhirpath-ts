/**
 * Shared expression-site rules for the TypeScript and ESTree walkers. This file
 * owns call names, argument shapes, receiver checks, and site context. Walkers
 * provide AST access only. It must not import TypeScript or ESLint at runtime.
 */
import {
  type ColumnFunctionSignature,
  columnSignature,
  type ColumnTypeClaim,
  criteriaSignature,
} from '../api/column-signature.ts'
import { bareEnvironmentName } from '../engine/context.ts'
import { type AnalyzerVariable, PROJECT_ROW_VARIABLES } from './declarations.ts'
import type { SourceVariablePlan } from './source-options.ts'

/** The supported expression argument shapes: one string, columns, constraints, or DTO variables. */
export type CallSiteShape = 'expression' | 'columns' | 'constraints' | 'dto-vars'

export interface CallSitePolicy {
  /** Which argument holds the expression(s): 0 for expression-first calls, 1 for subject-first helpers. */
  argIndex: number
  shape: CallSiteShape
  /**
   * Required receiver evidence. `any` accepts bare or member calls unless a
   * foreign import owns the name. `engine` requires a package import or local
   * `FhirPathEngine`. `import` requires the called name to come from this package.
   */
  receiver: 'any' | 'engine' | 'import'
  /**
   * The argument that names the type the expression runs against, when the call
   * takes one: `fhirpath('status', 'MedicationRequest')` declares it at index 1,
   * `defineDto('Condition', { vars })` at index 0. A site with a declared root is
   * analyzed against it, which is the only way a walker can check a relative
   * expression — see `analyzeSite`.
   */
  rootArg?: number
  /**
   * The root comes from the enclosing class's `extends defineDto('Condition')`
   * clause: a `@column`/`@criteria` field. A class extending anything else (a
   * base class, a root-generic factory) has no statically-known fhirType, and
   * the expression is analyzed without an input type.
   */
  rootFromClass?: true
  /** The EvaluateOptions argument whose inline env/vars declarations are visible to the expression. */
  optionsArg?: number
  /** Additional expressions held by the options argument. */
  optionsExpressions?: 'vars'
  /** The call supplies projection-only `%rowIndex` and `%rowTotal`. */
  rowVariables?: true
  /**
   * A DTO member site. Its `%variables` are never judged — they come from the
   * DTO's own `vars`/`env`, from a base class, or from the projecting call, none
   * of which a source walker can see in full — and an unresolved function is
   * reported only when it misspells a column of the same file. `analyzeDto`
   * checks all of it properly.
   */
  dto?: true
  /** Declares a zero-argument function named after the decorated field. */
  declaresField?: 'column' | 'criteria'
}

/** Call names that take FHIRPath expressions, and where/how/on-what they take them. */
export const CALL_SITES: ReadonlyMap<string, CallSitePolicy> = new Map([
  // Expression-first: the low-level API and the evaluate family of FhirPathEngine.
  // `fhirpath`/`compile` take the type the expression runs against as their
  // second argument, which is what makes an expression held in a `const` — and
  // evaluated somewhere else entirely — checkable.
  ['fhirpath', { argIndex: 0, shape: 'expression', receiver: 'any', rootArg: 1 }],
  ['compile', { argIndex: 0, shape: 'expression', receiver: 'any', rootArg: 1 }],
  ['evaluate', { argIndex: 0, shape: 'expression', receiver: 'any', optionsArg: 2, optionsExpressions: 'vars' }],
  ['evaluateTyped', { argIndex: 0, shape: 'expression', receiver: 'any', optionsArg: 2, optionsExpressions: 'vars' }],
  ['first', { argIndex: 0, shape: 'expression', receiver: 'engine', optionsArg: 2, optionsExpressions: 'vars' }],
  ['analyzeExpression', { argIndex: 0, shape: 'expression', receiver: 'any' }],
  // Subject-first FhirPathEngine helpers: the expression(s) come second.
  ['test', { argIndex: 1, shape: 'expression', receiver: 'engine', optionsArg: 2, optionsExpressions: 'vars' }],
  ['filter', { argIndex: 1, shape: 'expression', receiver: 'engine', optionsArg: 2, optionsExpressions: 'vars' }],
  [
    'project',
    {
      argIndex: 1,
      shape: 'columns',
      receiver: 'engine',
      optionsArg: 2,
      optionsExpressions: 'vars',
      rowVariables: true,
    },
  ],
  [
    'checkConstraints',
    { argIndex: 1, shape: 'constraints', receiver: 'any', optionsArg: 2, optionsExpressions: 'vars' },
  ],
  // DTO declarations: the column/criteria expressions of a `@column` field, and
  // the `vars` a DTO binds per row.
  [
    'column',
    { argIndex: 0, shape: 'expression', receiver: 'import', rootFromClass: true, dto: true, declaresField: 'column' },
  ],
  [
    'criteria',
    { argIndex: 0, shape: 'expression', receiver: 'import', rootFromClass: true, dto: true, declaresField: 'criteria' },
  ],
  ['defineDto', { argIndex: 1, shape: 'dto-vars', receiver: 'import', rootArg: 0, dto: true }],
])

/** The `defineDto` call whose first argument fixes a DTO's fhirType. */
export const DTO_BASE_NAME = 'defineDto'

/** The tag name whose no-substitution template holds a FHIRPath expression. */
export const TAG_NAME = 'fhirpath'

/** Imports from this package (any subpath) are the real FHIRPath API, never foreign. */
export const PACKAGE_PREFIX = 'fhirpath-ts'

/** The engine class name: `new FhirPathEngine(...)` locals are trusted bindings. */
export const ENGINE_CLASS_NAME = 'FhirPathEngine'

/**
 * Name bindings a walker collects from a source file before extracting sites.
 * Files without imports (scripts, snippets) have all sets empty: `receiver: 'any'`
 * names are then always checked, `receiver: 'engine'` names only via a
 * `new FhirPathEngine(...)` local.
 */
export interface SourceBindings {
  /**
   * Local names bound by imports from modules other than this package
   * (`compile` from handlebars is not a FHIRPath entry point).
   */
  foreign: ReadonlySet<string>
  /** Package imports and locals created with `new FhirPathEngine()`. */
  trusted: ReadonlySet<string>
  /**
   * Trusted names also declared for another purpose. Trust is file-wide, so a
   * rebound name is skipped to prevent false positives in another scope.
   */
  rebound: ReadonlySet<string>
}

/** Semantic receiver facts a compiler-backed walker can prove. */
export interface ReceiverEvidence {
  /** The receiver resolves to this package's FhirPathEngine declaration. */
  engine?: true
}

/**
 * Whether a call site should be checked, given its policy and the file's
 * bindings. `receiverRoot` is the leftmost identifier of a member-expression
 * callee (`Handlebars` in `Handlebars.compile(...)`, `db` in
 * `db.clients.first(...)`), or undefined for a bare-identifier callee or a
 * non-identifier root (`this`, a call result).
 */
export function isCheckedCall(
  policy: CallSitePolicy,
  calleeName: string,
  receiverRoot: string | undefined,
  bindings: SourceBindings,
  evidence: ReceiverEvidence = {}
): boolean {
  if (policy.receiver === 'import') {
    return receiverRoot === undefined && bindings.trusted.has(calleeName) && !bindings.rebound.has(calleeName)
  }
  if (evidence.engine === true) {
    return true
  }
  if (policy.receiver === 'engine') {
    return receiverRoot !== undefined && bindings.trusted.has(receiverRoot) && !bindings.rebound.has(receiverRoot)
  }
  return !bindings.foreign.has(receiverRoot ?? calleeName)
}

/** Checks a `fhirpath` tag unless its bare name or namespace comes from another package. */
export function isCheckedTag(receiverRoot: string | undefined, bindings: SourceBindings): boolean {
  return !bindings.foreign.has(receiverRoot ?? TAG_NAME)
}

/**
 * Whether `new className(...)` yields a trusted binding: any class imported from
 * this package counts, and the bare `FhirPathEngine` name also counts in files
 * whose imports don't claim it — so import-less snippets stay checkable.
 */
export function constructsEngine(className: string, bindings: SourceBindings): boolean {
  return bindings.trusted.has(className) || (className === ENGINE_CLASS_NAME && !bindings.foreign.has(className))
}

/** Which import sources count as the real FHIRPath API rather than a foreign module. */
export interface LocalModuleOptions {
  /** Import-source prefixes that are the FHIRPath API. Defaults to `['fhirpath-ts']`. */
  packages?: readonly string[]
  /**
   * Also treat relative imports (`./`, `../`) as the FHIRPath API. Off by default
   * (a consumer's relative `compile` is not FHIRPath); turn it on so the package
   * can dogfood the rule on its own source, which imports its API relatively.
   */
  localImports?: boolean
}

/**
 * Whether an import specifier's module is foreign (not the FHIRPath API). By
 * default only `fhirpath-ts` (any subpath) is local; `options` widens that to
 * extra package prefixes and/or relative imports.
 */
export function isForeignModule(moduleSpecifier: string, options: LocalModuleOptions = {}): boolean {
  const packages = options.packages ?? [PACKAGE_PREFIX]
  if (packages.some(prefix => moduleSpecifier.startsWith(prefix))) {
    return false
  }
  if (options.localImports === true && moduleSpecifier.startsWith('.')) {
    return false
  }
  return true
}

/** An extracted expression literal: the AST node (for reporting) and its text. */
export interface ExpressionEntry<N> {
  node: N
  expression: string
}

/**
 * What a site tells `analyzeSite` about itself, beyond the expression text: the
 * type the expression runs against, and whether it is a DTO member. Both walkers
 * produce this shape so `analyzeSite` cannot be handed two different vocabularies.
 */
export interface SiteContext {
  /** The type the expression is analyzed against, when the site fixes one. */
  inputType?: string
  /** A DTO member site, whose findings are weighed differently (see `CallSitePolicy.dto`). */
  dto?: true
  /** Inline per-call environment and row-variable declarations visible to this site. */
  variables?: Readonly<Record<string, SiteVariable>>
  /** Ordered per-call vars, kept separate so loaded engine defaults can be merged without losing runtime order. */
  variablePlan?: SiteVariablePlan
  /**
   * The call binds variables the source cannot name: a computed key, a spread,
   * or a non-literal env/vars object. An unresolved `%variable` at such a site
   * may exist at runtime, so it is a coverage gap rather than an error — see
   * `analyzeSite`.
   */
  openVariables?: true
}

/** Analyzer facts a source literal can declare; ordering requires runtime knowledge. */
export type SiteVariable = Pick<AnalyzerVariable, 'types' | 'single' | 'targets'>

/** The vars state at one expression: declarations apply as each value runs, then to the completed scope. */
export type SiteVariablePlan = SourceVariablePlan

/** One class of a file, as a walker reads its heritage clause. */
export interface ClassHeritage {
  /** The class's own name, when it has one. */
  name: string | undefined
  /** The fhirType its own `extends defineDto('X')` clause fixes, when it has one. */
  ownRoot: string | undefined
  /** The name of the class it extends, when that clause is a plain identifier. */
  baseName: string | undefined
}

/**
 * Resolves DTO roots through base classes declared in the same file. Duplicate
 * names, cycles, factories, and imported bases remain unresolved because the
 * source cannot prove their root.
 */
export function dtoRootsOf(classes: readonly ClassHeritage[]): ReadonlyMap<string, string> {
  const byName = new Map<string, ClassHeritage>()
  const ambiguous = new Set<string>()
  for (const cls of classes) {
    if (cls.name === undefined) {
      continue
    }
    if (byName.has(cls.name)) {
      ambiguous.add(cls.name)
    }
    byName.set(cls.name, cls)
  }
  const rootOf = (cls: ClassHeritage, seen: Set<string>): string | undefined => {
    if (cls.ownRoot !== undefined) {
      return cls.ownRoot
    }
    const base = cls.baseName
    if (base === undefined || ambiguous.has(base) || seen.has(base)) {
      return undefined
    }
    const declaration = byName.get(base)
    if (declaration === undefined) {
      return undefined
    }
    seen.add(base)
    return rootOf(declaration, seen)
  }
  const roots = new Map<string, string>()
  for (const [name, cls] of byName) {
    if (ambiguous.has(name)) {
      continue
    }
    const root = rootOf(cls, new Set([name]))
    if (root !== undefined) {
      roots.set(name, root)
    }
  }
  return roots
}

/**
 * The DTO root a class's `@column` fields analyze against: its own
 * `extends defineDto('X')` clause, else whatever its `extends` chain settled on in
 * `dtoRootsOf`. Its own clause wins outright, so a class whose *name* the file
 * declares twice — dropped from the chain, since a wrong root would report valid
 * code — still checks its own columns.
 */
export function rootOf(heritage: ClassHeritage | undefined, dtoRoots: ReadonlyMap<string, string>): string | undefined {
  if (heritage === undefined || heritage.ownRoot !== undefined) {
    return heritage?.ownRoot
  }
  return heritage.name === undefined ? undefined : dtoRoots.get(heritage.name)
}

/**
 * The context a call site's expressions carry, per its policy. The root is named
 * either by one of the call's own arguments (`fhirpath(expr, 'Patient')`,
 * `defineDto('Condition', …)`) or by the enclosing class's `extends defineDto(…)`
 * clause, which the walker resolves and passes as `classRoot`. Mapping a policy
 * to a context is a decision, so it happens here rather than once per walker —
 * the two drifted while each had its own copy.
 */
export function siteContext<N>(
  policy: CallSitePolicy,
  argumentAt: (index: number) => N | undefined,
  classRoot: string | undefined,
  ast: ExpressionAst<N>,
  variables: Readonly<Record<string, SiteVariable>> | undefined
): SiteContext {
  const rootArgument = policy.rootArg === undefined ? undefined : argumentAt(policy.rootArg)
  const inputType =
    rootArgument !== undefined
      ? ast.string(rootArgument)?.expression
      : policy.rootFromClass === true
        ? classRoot
        : undefined
  return {
    ...(policy.dto === true && { dto: true as const }),
    ...(inputType !== undefined && { inputType }),
    ...(variables !== undefined && Object.keys(variables).length > 0 && { variables }),
  }
}

export interface OptionScopes<N> {
  env: Record<string, SiteVariable>
  vars: Record<string, SiteVariable>
  /** Final declarations only, without value-only names. */
  varDeclarations: Record<string, SiteVariable>
  /** Whether this closed options object definitely omits varTypes. */
  inheritsVarDeclarations: boolean
  /**
   * The options bind variables whose names the source cannot enumerate before
   * any var expression runs: an open `env`/`envTypes` object, or an unresolved
   * options write that may supply either one.
   */
  openBeforeVars: boolean
  /** Whether the completed env/vars/type declarations may bind additional names. */
  openAfterVars: boolean
  /** Final ordered `vars` entries, or one coverage gap when their order is dynamic. */
  expressions: (ExpressionCandidate<N> & { name?: string })[]
}

/** Parse one literal EvaluateOptions object into environment and ordered var scopes. */
export function optionScopes<N>(options: N, ast: ExpressionAst<N>): OptionScopes<N> | undefined {
  const properties = ast.properties(options)
  if (properties === undefined) {
    return undefined
  }
  const lastUnknown = properties.findLastIndex(property => property.name === undefined)
  const envValues = finalKnownProperty(properties, 'env', lastUnknown)
  const envDeclarations = finalKnownProperty(properties, 'envTypes', lastUnknown)
  const varValues = finalKnownProperty(properties, 'vars', lastUnknown)
  const varDeclarations = finalKnownProperty(properties, 'varTypes', lastUnknown)
  const varsProperties = varValues === undefined ? [] : ast.properties(varValues)
  const envScope = variablesFromPair(envValues, envDeclarations, ast)
  const varScope = variablesFromPair(varValues, varDeclarations, ast)
  const unknownOptions = lastUnknown >= 0
  // env/envTypes exist while var bodies run. vars/varTypes only finish binding
  // after those bodies have run, so an unknown varTypes name must not hide a
  // real error inside a var expression.
  const openBeforeVars =
    envScope.valuesOpen ||
    envScope.declarationsOpen ||
    (unknownOptions && (envValues === undefined || envDeclarations === undefined))
  const dynamicVars = varsProperties === undefined || varsProperties.some(property => property.name === undefined)
  return {
    env: envScope.variables,
    vars: varScope.variables,
    varDeclarations: varScope.declarations,
    inheritsVarDeclarations: !unknownOptions && varDeclarations === undefined,
    openBeforeVars,
    openAfterVars:
      openBeforeVars ||
      dynamicVars ||
      varScope.declarationsOpen ||
      (unknownOptions && (varValues === undefined || varDeclarations === undefined)),
    expressions:
      varValues === undefined
        ? []
        : dynamicVars
          ? [{ node: varValues, uncheckable: 'dynamic-vars' as const }]
          : finalVarExpressions(varsProperties, ast),
  }
}

/** Final values in Object.entries order when every vars key is statically known. */
function finalVarExpressions<N>(
  properties: readonly ExpressionProperty<N>[],
  ast: ExpressionAst<N>
): (ExpressionCandidate<N> & { name: string })[] {
  return finalNormalizedEntries(properties).flatMap(({ name, value: node }) => {
    const entry = ast.string(node)
    return [{ node, name, ...(entry !== undefined && { expression: entry.expression }) }]
  })
}

/** Runtime entries after Object.entries(), bare-name normalization, and Object.entries() again. */
function finalNormalizedEntries<N>(properties: readonly ExpressionProperty<N>[]): { name: string; value: N }[] {
  const raw: Record<string, N> = Object.create(null)
  for (const property of properties) {
    if (property.name !== undefined) {
      raw[property.name] = property.value
    }
  }
  const normalized: Record<string, N> = Object.create(null)
  for (const [rawName, value] of Object.entries(raw)) {
    normalized[bareEnvironmentName(rawName)] = value
  }
  return Object.entries(normalized).map(([name, value]) => ({ name, value }))
}

/** Known names and provably final values of one normalized host map. */
function normalizedObjectWrites<N>(
  node: N | undefined,
  ast: ExpressionAst<N>
): {
  names: string[]
  final: { name: string; value: N }[]
  open: boolean
} {
  if (node === undefined) {
    return { names: [], final: [], open: false }
  }
  const properties = ast.properties(node)
  if (properties === undefined) {
    return { names: [], final: [], open: true }
  }
  const names = [
    ...new Set(
      properties.flatMap(property => (property.name === undefined ? [] : [bareEnvironmentName(property.name)]))
    ),
  ]
  const open = properties.some(property => property.name === undefined)
  // An unknown raw key can establish either `%x` or `x` first. Overwriting a
  // property does not move that insertion position, so no normalized value is
  // provably final once the map is open.
  const final = open ? [] : finalNormalizedEntries(properties)
  return { names, final, open }
}

function variablesFromPair<N>(
  values: N | undefined,
  declared: N | undefined,
  ast: ExpressionAst<N>
): {
  variables: Record<string, SiteVariable>
  declarations: Record<string, SiteVariable>
  valuesOpen: boolean
  declarationsOpen: boolean
} {
  const valueWrites = normalizedObjectWrites(values, ast)
  const declarationWrites = normalizedObjectWrites(declared, ast)
  const variables = Object.fromEntries(valueWrites.names.map(name => [name, {}]))
  const declarations: Record<string, SiteVariable> = {}
  for (const { name, value } of declarationWrites.final) {
    const declaration = typeDeclaration(value, ast)
    if (declaration !== undefined) {
      declarations[name] = declaration
    }
  }
  return {
    variables: { ...variables, ...declarations },
    declarations,
    valuesOpen: valueWrites.open,
    declarationsOpen: declarationWrites.open,
  }
}

/** Last named property after an unknown write that could replace its value. */
function finalKnownProperty<N>(
  properties: readonly ExpressionProperty<N>[] | undefined,
  name: string,
  after: number
): N | undefined {
  let value: N | undefined
  for (const property of properties?.slice(after + 1) ?? []) {
    if (property.name === name) {
      value = property.value
    }
  }
  return value
}

function typeDeclaration<N>(node: N, ast: ExpressionAst<N>): SiteVariable | undefined {
  const properties = ast.properties(node)
  if (properties === undefined) {
    return undefined
  }
  const lastUnknown = properties.findLastIndex(property => property.name === undefined)
  const typeNode = finalKnownProperty(properties, 'type', lastUnknown)
  const types = typeNode === undefined ? undefined : literalStrings(typeNode, ast)
  if (types === undefined || types.length === 0) {
    return undefined
  }
  const collectionNode = finalKnownProperty(properties, 'collection', lastUnknown)
  const collection = collectionNode === undefined ? (lastUnknown < 0 ? false : undefined) : ast.boolean(collectionNode)
  const targetsNode = finalKnownProperty(properties, 'targets', lastUnknown)
  const targets = targetsNode === undefined ? undefined : literalStrings(targetsNode, ast)
  return {
    types,
    ...(collection !== undefined && { single: !collection }),
    ...(targets !== undefined && targets.length > 0 && { targets }),
  }
}

function literalStrings<N>(node: N, ast: ExpressionAst<N>): string[] | undefined {
  const one = ast.string(node)?.expression
  if (one !== undefined) {
    return [one]
  }
  const elements = ast.elements(node)
  if (elements === undefined) {
    return undefined
  }
  const strings = elements.map(element => ast.string(element)?.expression)
  return strings.every(value => value !== undefined) ? strings : undefined
}

/**
 * The AST accessors a walker provides so shape extraction can be written once.
 * Each returns undefined when the node is not of the asked-for kind, which the
 * extractor treats as "dynamic, skip" — so spreads, shorthands, computed values,
 * and variables all fall out of the same rule in both walkers.
 */
export interface ExpressionAst<N> {
  /** The node as a string literal entry, or undefined when it is not one. */
  string(node: N): ExpressionEntry<N> | undefined
  /** The node's value as a `true`/`false` literal, or undefined when it is not one. */
  boolean(node: N): boolean | undefined
  /**
   * The properties of an object literal in source order, including shorthand
   * properties whose value is the identifier itself, or undefined when the node
   * is not an object literal. `name` is the property's statically-known key —
   * a plain or computed string literal, or an identifier — and undefined for
   * other computed keys. A spread carries `spread: true`, no name, and the
   * spread expression as its value.
   */
  properties(node: N): ExpressionProperty<N>[] | undefined
  /** The elements of an array literal, or undefined when the node is not one. */
  elements(node: N): N[] | undefined
}

/** One object-literal write as exposed by either source walker. */
export interface ExpressionProperty<N> {
  name: string | undefined
  value: N
  spread?: true
}

/** One expression-shaped node, whether or not its value is a static string. */
export interface ExpressionCandidate<N> {
  node: N
  expression?: string
  /** The node contains expressions, but their final names/order cannot be proven. */
  uncheckable?: 'dynamic-vars'
}

/** One call expression paired with the source facts visible at that exact point. */
export interface ContextualExpressionCandidate<N> extends ExpressionCandidate<N> {
  context: SiteContext
  source: 'argument' | 'option-var'
}

/**
 * Expand one supported call into every expression-shaped node and its context.
 * EvaluateOptions vars bind in declaration order after env. Project vars also
 * see the row variables, and project columns see the completed var scope.
 * A construct that binds names the source cannot list marks the relevant scope
 * open. Dynamic `vars` keys also make the final expression values and
 * Object.entries order unknowable: a later spread can overwrite an earlier
 * value while retaining its original key position. Such var bodies become one
 * explicit coverage gap instead of producing false diagnostics.
 */
export function callExpressionCandidates<N>(
  policy: CallSitePolicy,
  argumentAt: (index: number) => N | undefined,
  classRoot: string | undefined,
  ast: ExpressionAst<N>
): ContextualExpressionCandidate<N>[] {
  const argument = argumentAt(policy.argIndex)
  if (argument === undefined) {
    return []
  }
  const options = policy.optionsArg === undefined ? undefined : argumentAt(policy.optionsArg)
  const scopes = options === undefined ? undefined : optionScopes(options, ast)
  const openBeforeVars = options !== undefined && (scopes === undefined || scopes.openBeforeVars)
  const openAfterVars = options !== undefined && (scopes === undefined || scopes.openAfterVars)
  const base = siteContext(policy, argumentAt, classRoot, ast, {
    ...scopes?.env,
    ...(policy.rowVariables === true && PROJECT_ROW_VARIABLES),
  })
  const values = scopes?.expressions.flatMap(entry => (entry.name === undefined ? [] : [entry.name])) ?? []
  const plan =
    options === undefined
      ? undefined
      : {
          values,
          declarations: scopes?.varDeclarations ?? {},
          inheritsDeclarations: scopes?.inheritsVarDeclarations ?? false,
        }
  const context: SiteContext = {
    ...base,
    ...(plan !== undefined && { variablePlan: plan }),
    ...(openAfterVars && { openVariables: true }),
  }
  const candidates: ContextualExpressionCandidate<N>[] = expressionCandidates(argument, policy.shape, ast).map(
    candidate => ({
      ...candidate,
      context,
      source: 'argument' as const,
    })
  )
  if (policy.optionsExpressions !== 'vars' || policy.optionsArg === undefined) {
    return candidates
  }
  if (scopes === undefined) {
    return candidates
  }
  for (const entry of scopes.expressions) {
    candidates.push({
      node: entry.node,
      ...(entry.expression !== undefined && { expression: entry.expression }),
      ...(entry.uncheckable !== undefined && { uncheckable: entry.uncheckable }),
      context: {
        ...base,
        variablePlan: {
          values,
          declarations: scopes.varDeclarations,
          inheritsDeclarations: scopes.inheritsVarDeclarations,
          ...(entry.name !== undefined && { before: entry.name }),
        },
        ...(openBeforeVars && { openVariables: true as const }),
      },
      source: 'option-var',
    })
  }
  return candidates
}

/** Canonical traversal of every supported expression container. */
export function expressionCandidates<N>(
  argument: N,
  shape: CallSiteShape,
  ast: ExpressionAst<N>
): ExpressionCandidate<N>[] {
  if (shape === 'expression') {
    const entry = ast.string(argument)
    return [{ node: argument, ...(entry !== undefined && { expression: entry.expression }) }]
  }
  if (shape === 'columns') {
    // A non-object may be a DTO class, which holds no source expressions. A
    // spread holds no column literal of its own.
    return (ast.properties(argument) ?? []).flatMap(({ value, spread }) => {
      if (spread === true) {
        return []
      }
      const entry = ast.string(value)
      if (entry !== undefined) {
        return [{ node: value, expression: entry.expression }]
      }
      const nested = ast.properties(value)
      if (nested === undefined) {
        return [{ node: value }]
      }
      return nested.flatMap(property => {
        if (property.name !== 'path' && property.name !== 'test') {
          return []
        }
        const nestedEntry = ast.string(property.value)
        return [{ node: property.value, ...(nestedEntry !== undefined && { expression: nestedEntry.expression }) }]
      })
    })
  }
  if (shape === 'dto-vars') {
    const vars = (ast.properties(argument) ?? []).filter(({ name }) => name === 'vars')
    return vars.flatMap(({ value }) => {
      const properties = ast.properties(value)
      return properties === undefined
        ? [{ node: value }]
        : properties.flatMap(property => {
            if (property.spread === true) {
              return []
            }
            const entry = ast.string(property.value)
            return [{ node: property.value, ...(entry !== undefined && { expression: entry.expression }) }]
          })
    })
  }
  const elements = ast.elements(argument)
  if (elements === undefined) {
    return [{ node: argument }]
  }
  return elements.flatMap(element => {
    const properties = ast.properties(element)
    if (properties === undefined) {
      return [{ node: element }]
    }
    return properties.flatMap(property => {
      if (property.name !== 'expression') {
        return []
      }
      const entry = ast.string(property.value)
      return [{ node: property.value, ...(entry !== undefined && { expression: entry.expression }) }]
    })
  })
}

/**
 * What a DTO column declares as a function: every `@column` field of a
 * registered DTO becomes a zero-argument expression function named by the field
 * (see `withDtos`), so a walker that reads a file's columns can resolve the
 * calls between them. Shaped to be assignable to the analyzer's
 * `DeclaredFunction`.
 */
export interface DeclaredColumnFunction {
  minArity: 0
  maxArity: 0
  signature?: ColumnFunctionSignature
}

/** One field name of a file, with every class that declares it (see `declaredColumnOverloads`). */
export type FileColumnFunction = DeclaredColumnFunction | { overloads: readonly DeclaredColumnFunction[] }

/**
 * Builds a DTO column's function declaration from literal source options and a
 * visible class root. Unknown roots omit the input claim. Dynamic options omit
 * the result claim.
 */
export function columnFunctionDeclaration<N>(
  kind: 'column' | 'criteria',
  options: N | undefined,
  ast: ExpressionAst<N>,
  hostType: string | undefined
): DeclaredColumnFunction {
  const declaration: DeclaredColumnFunction = { minArity: 0, maxArity: 0 }
  if (kind === 'criteria') {
    // A criteria takes no options object. Its result is a single Boolean
    // whatever the expression returns, because the rule lives on the function.
    return { ...declaration, signature: criteriaSignature(hostType) }
  }
  const signature = columnSignature(columnClaim(options, ast), hostType)
  return signature === undefined ? declaration : { ...declaration, signature }
}

/** Keeps every same-name column declaration as an overload for focus-based analysis. */
export function declaredColumnOverloads(
  seen: FileColumnFunction | undefined,
  next: DeclaredColumnFunction
): FileColumnFunction {
  if (seen === undefined) {
    return next
  }
  return { overloads: [...('overloads' in seen ? seen.overloads : [seen]), next] }
}

/**
 * Reads the type claim a column's options object makes. The answer is an empty
 * claim whenever the source cannot say: no options at all, options that are not
 * an object literal, or a `collection` set from a variable, where a guessed
 * cardinality would be worse than none. All three produce no result claim,
 * which leaves the input type as the only thing the declaration carries.
 */
function columnClaim<N>(options: N | undefined, ast: ExpressionAst<N>): ColumnTypeClaim & { collection?: boolean } {
  const properties = options === undefined ? undefined : ast.properties(options)
  if (properties === undefined) {
    return {}
  }
  const lastUnknown = properties.findLastIndex(property => property.name === undefined)
  if (lastUnknown >= 0) {
    // A spread/computed key can introduce `as` or `choices`; later type and
    // collection writes do not remove those conversion modes. Keep only the
    // independently known input signature.
    return {}
  }
  const named = (name: string): N | undefined => finalKnownProperty(properties, name, lastUnknown)
  const collection = named('collection')
  const isCollection = collection === undefined ? (lastUnknown < 0 ? false : undefined) : ast.boolean(collection)
  if (isCollection === undefined) {
    return {}
  }
  const declaredType = named('type')
  return {
    ...(declaredType !== undefined && { type: ast.string(declaredType)?.expression }),
    ...(named('enum') !== undefined && { enum: true }),
    ...(named('as') !== undefined && { as: true }),
    ...(named('choices') !== undefined && { choices: true }),
    collection: isCollection,
  }
}
