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
  /** Additional expressions held by the options argument, such as project() row vars. */
  optionsExpressions?: 'vars'
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
  ['evaluate', { argIndex: 0, shape: 'expression', receiver: 'any', optionsArg: 2 }],
  ['evaluateTyped', { argIndex: 0, shape: 'expression', receiver: 'any', optionsArg: 2 }],
  ['first', { argIndex: 0, shape: 'expression', receiver: 'engine', optionsArg: 2 }],
  ['analyzeExpression', { argIndex: 0, shape: 'expression', receiver: 'any' }],
  // Subject-first FhirPathEngine helpers: the expression(s) come second.
  ['test', { argIndex: 1, shape: 'expression', receiver: 'engine', optionsArg: 2 }],
  ['filter', { argIndex: 1, shape: 'expression', receiver: 'engine', optionsArg: 2 }],
  ['project', { argIndex: 1, shape: 'columns', receiver: 'engine', optionsArg: 2, optionsExpressions: 'vars' }],
  ['checkConstraints', { argIndex: 1, shape: 'constraints', receiver: 'any', optionsArg: 2 }],
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
  bindings: SourceBindings
): boolean {
  if (policy.receiver === 'engine') {
    return receiverRoot !== undefined && bindings.trusted.has(receiverRoot) && !bindings.rebound.has(receiverRoot)
  }
  if (policy.receiver === 'import') {
    return receiverRoot === undefined && bindings.trusted.has(calleeName) && !bindings.rebound.has(calleeName)
  }
  if (bindings.trusted.has(receiverRoot ?? calleeName) && !bindings.rebound.has(receiverRoot ?? calleeName)) {
    return true
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
}

/** The analyzer facts a source literal can declare without evaluating host code. */
export interface SiteVariable {
  types?: string[]
  single?: boolean
  targets?: string[]
}

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
  ast: ExpressionAst<N>
): SiteContext {
  const rootArgument = policy.rootArg === undefined ? undefined : argumentAt(policy.rootArg)
  const inputType =
    rootArgument !== undefined
      ? ast.string(rootArgument)?.expression
      : policy.rootFromClass === true
        ? classRoot
        : undefined
  const optionsArgument = policy.optionsArg === undefined ? undefined : argumentAt(policy.optionsArg)
  const variables = {
    ...(optionsArgument === undefined ? undefined : variablesFromOptions(optionsArgument, ast, true)),
    ...(policy.optionsExpressions === 'vars' && {
      rowIndex: { types: ['System.Integer'], single: true },
      rowTotal: { types: ['System.Integer'], single: true },
    }),
  }
  return {
    ...(policy.dto === true && { dto: true as const }),
    ...(inputType !== undefined && { inputType }),
    ...(Object.keys(variables).length > 0 && { variables }),
  }
}

/** Variables declared by a literal EvaluateOptions object. */
export function variablesFromOptions<N>(
  options: N,
  ast: ExpressionAst<N>,
  includeVars: boolean
): Record<string, SiteVariable> | undefined {
  const properties = ast.properties(options)
  if (properties === undefined) {
    return undefined
  }
  const variables: Record<string, SiteVariable> = {}
  const addNames = (propertyName: 'env' | 'vars'): void => {
    const value = properties.find(property => property.name === propertyName)?.value
    for (const property of value === undefined ? [] : (ast.properties(value) ?? [])) {
      if (property.name !== undefined) {
        variables[bareVariableName(property.name)] = {}
      }
    }
  }
  const addDeclarations = (propertyName: 'envTypes' | 'varTypes'): void => {
    const value = properties.find(property => property.name === propertyName)?.value
    for (const property of value === undefined ? [] : (ast.properties(value) ?? [])) {
      if (property.name === undefined) {
        continue
      }
      const declaration = typeDeclaration(property.value, ast)
      if (declaration !== undefined) {
        variables[bareVariableName(property.name)] = declaration
      }
    }
  }
  addNames('env')
  addDeclarations('envTypes')
  if (includeVars) {
    addNames('vars')
    addDeclarations('varTypes')
  }
  return variables
}

function typeDeclaration<N>(node: N, ast: ExpressionAst<N>): SiteVariable | undefined {
  const properties = ast.properties(node)
  if (properties === undefined) {
    return undefined
  }
  const typeNode = properties.find(property => property.name === 'type')?.value
  const types = typeNode === undefined ? undefined : literalStrings(typeNode, ast)
  if (types === undefined || types.length === 0) {
    return undefined
  }
  const collectionNode = properties.find(property => property.name === 'collection')?.value
  const collection = collectionNode === undefined ? false : ast.boolean(collectionNode)
  const targetsNode = properties.find(property => property.name === 'targets')?.value
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

function bareVariableName(name: string): string {
  return name.startsWith('%') ? name.slice(1) : name
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
   * The plain (non-spread) properties of an object literal, including shorthand
   * properties whose value is the identifier itself, or
   * undefined when the node is not an object literal. `name` is the property's
   * statically-known key — undefined for computed keys.
   */
  properties(node: N): { name: string | undefined; value: N }[] | undefined
  /** The elements of an array literal, or undefined when the node is not one. */
  elements(node: N): N[] | undefined
}

/**
 * Extract the expression literal(s) an argument holds, per the call site's shape.
 * Column keys are output names, not expressions, so a computed key does not stop
 * its value from being checked; `{ path }` / `{ expression }` lookups match
 * identifier and string-literal keys only.
 */
export function expressionEntries<N>(argument: N, shape: CallSiteShape, ast: ExpressionAst<N>): ExpressionEntry<N>[] {
  if (shape === 'expression') {
    const entry = ast.string(argument)
    return entry ? [entry] : []
  }
  if (shape === 'columns') {
    // project() columns: { name: 'expr' }, { name: { path: 'expr', ... } }, or
    // the boolean-criteria form { name: { test: 'expr' } }.
    return (ast.properties(argument) ?? []).flatMap(({ value }) => {
      const entry = ast.string(value)
      return entry ? [entry] : [...namedStringEntries(value, 'path', ast), ...namedStringEntries(value, 'test', ast)]
    })
  }
  if (shape === 'dto-vars') {
    // defineDto() options: { vars: { name: 'expr' }, callerEnv: [...] }. Only
    // vars hold expressions.
    const vars = (ast.properties(argument) ?? []).filter(({ name }) => name === 'vars')
    return vars.flatMap(({ value }) =>
      (ast.properties(value) ?? []).flatMap(({ value: expression }) => {
        const entry = ast.string(expression)
        return entry ? [entry] : []
      })
    )
  }
  // checkConstraints() constraints: [{ key, expression: 'expr', ... }].
  return (ast.elements(argument) ?? []).flatMap(element => namedStringEntries(element, 'expression', ast))
}

/** Nodes in a supported expression container that are present but not static strings. */
export function unreadExpressionNodes<N>(argument: N, shape: CallSiteShape, ast: ExpressionAst<N>): N[] {
  if (shape === 'expression') {
    return ast.string(argument) === undefined ? [argument] : []
  }
  if (shape === 'columns') {
    // A non-object may be a DTO class, which holds no source expressions.
    return (ast.properties(argument) ?? []).flatMap(({ value }) => {
      if (ast.string(value) !== undefined) {
        return []
      }
      const nested = ast.properties(value)
      if (nested === undefined) {
        return [value]
      }
      return nested.flatMap(property =>
        (property.name === 'path' || property.name === 'test') && ast.string(property.value) === undefined
          ? [property.value]
          : []
      )
    })
  }
  if (shape === 'dto-vars') {
    const vars = (ast.properties(argument) ?? []).filter(({ name }) => name === 'vars')
    return vars.flatMap(({ value }) => {
      const properties = ast.properties(value)
      return properties === undefined
        ? [value]
        : properties.flatMap(property => (ast.string(property.value) === undefined ? [property.value] : []))
    })
  }
  const elements = ast.elements(argument)
  if (elements === undefined) {
    return [argument]
  }
  return elements.flatMap(element => {
    const properties = ast.properties(element)
    if (properties === undefined) {
      return [element]
    }
    return properties.flatMap(property =>
      property.name === 'expression' && ast.string(property.value) === undefined ? [property.value] : []
    )
  })
}

/** The string-literal values of an object literal's `name` properties. */
function namedStringEntries<N>(object: N, name: string, ast: ExpressionAst<N>): ExpressionEntry<N>[] {
  return (ast.properties(object) ?? []).flatMap(({ name: key, value }) => {
    if (key !== name) {
      return []
    }
    const entry = ast.string(value)
    return entry ? [entry] : []
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
  const named = (name: string): N | undefined => properties.find(property => property.name === name)?.value
  const collection = named('collection')
  const isCollection = collection === undefined ? false : ast.boolean(collection)
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
