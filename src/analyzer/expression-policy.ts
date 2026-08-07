/**
 * Shared policy for deciding which call/tag sites in source code hold FHIRPath
 * expressions. Both the `fhirpath-check` CLI (TypeScript AST) and the ESLint rule
 * (ESTree AST) apply the same rules; only the tree-walking differs, so everything
 * that is a *decision* lives here — the call-name table, the check/skip rules,
 * the context a site carries, and the expression-shape extraction (via the
 * `ExpressionAst` adapter) — and the walkers supply only AST access. This module
 * must stay free of `typescript` and `eslint` imports so either walker can load
 * it alone; `column-signature.ts` is dependency-free for the same reason.
 */
import {
  type ColumnFunctionSignature,
  columnSignature,
  type ColumnTypeClaim,
  criteriaSignature,
} from '../api/column-signature.ts'

/**
 * How a call site carries its FHIRPath expression(s):
 * - `expression`: the argument is the expression string itself.
 * - `columns`: the argument is a `project()` columns object — each property value
 *   is an expression string, a `{ path }` object, or a `{ test }` criteria object.
 * - `constraints`: the argument is a `checkConstraints()` array of
 *   `{ expression }` constraint objects.
 * - `dto-vars`: the argument is a `defineDto()` options object — each `vars`
 *   property value is an expression.
 */
export type CallSiteShape = 'expression' | 'columns' | 'constraints' | 'dto-vars'

export interface CallSitePolicy {
  /** Which argument holds the expression(s): 0 for expression-first calls, 1 for subject-first helpers. */
  argIndex: number
  shape: CallSiteShape
  /**
   * What the callee's receiver must be for the call to be checked:
   * - `any`: checked unless the name is bound by a foreign import — right for
   *   distinctive names (`fhirpath`, `analyzeExpression`) that rarely collide.
   * - `engine`: checked only when the receiver root is a trusted binding
   *   (imported from this package, or a `new FhirPathEngine(...)` local —
   *   see `SourceBindings.trusted`).
   *   Required for `test`/`filter`/`first`/`project`: they exist only as engine
   *   methods, and the names are so common (knex `db.first('col')`, lodash
   *   `_.filter(...)`) that flag-by-default would report other libraries' code.
   *   The cost: an engine reached through an untracked alias (`this.engine`,
   *   a function parameter) is not checked.
   * - `import`: checked only when the callee name itself is a trusted binding —
   *   a name this file imported from the package. Right for the DTO vocabulary
   *   (`column`, `criteria`, `defineDto`): the names are ordinary words other
   *   libraries use too (a table's `column('id')`), and a DTO always imports
   *   them, so requiring the import costs nothing and reports nobody else.
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
  /**
   * A DTO member site. Its `%variables` are never judged — they come from the
   * DTO's own `vars`/`env`, from a base class, or from the projecting call, none
   * of which a source walker can see in full — and an unresolved function is
   * reported only when it misspells a column of the same file. `analyzeDto`
   * checks all of it properly.
   */
  dto?: true
  /**
   * The call declares a function named after the field it decorates, and says
   * which kind of column it is. A registered `@column` or `@criteria` becomes a
   * zero-argument function that every expression on that engine can call (see
   * `withDtos`). A walker collects one per decorated field and passes them to
   * `analyzeSite`, which is how a call between a file's own columns resolves.
   * The kind decides the signature: a criteria returns a single Boolean whatever
   * its expression returns, so there are no options to read. This lives in the
   * table rather than as a name comparison in each walker, so the two walkers
   * cannot disagree about which call it is.
   */
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
  ['evaluate', { argIndex: 0, shape: 'expression', receiver: 'any' }],
  ['evaluateTyped', { argIndex: 0, shape: 'expression', receiver: 'any' }],
  ['first', { argIndex: 0, shape: 'expression', receiver: 'engine' }],
  ['analyzeExpression', { argIndex: 0, shape: 'expression', receiver: 'any' }],
  // Subject-first FhirPathEngine helpers: the expression(s) come second.
  ['test', { argIndex: 1, shape: 'expression', receiver: 'engine' }],
  ['filter', { argIndex: 1, shape: 'expression', receiver: 'engine' }],
  ['project', { argIndex: 1, shape: 'columns', receiver: 'engine' }],
  ['checkConstraints', { argIndex: 1, shape: 'constraints', receiver: 'any' }],
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
  /**
   * Receiver roots trusted to be this package's API objects: every local name
   * bound by a package import (`r4`, a namespace import), plus locals declared
   * with `new FhirPathEngine(...)` (see `constructsEngine`). Trusted is wider
   * than "engine" on purpose: any package import counts, so
   * `r4Model.filter(rows, '...')` is analyzed even though `r4Model` is not an
   * engine — a hand-maintained list of which exports are engines would drift.
   * It is also narrower than the runtime: an engine reached through an
   * untracked alias (`this.engine`, a function parameter) or bound by
   * assignment rather than declaration (`let e; e = new FhirPathEngine()`)
   * is not tracked.
   */
  trusted: ReadonlySet<string>
  /**
   * Names the file re-binds by anything other than a package import or an
   * engine construction: parameters (including destructuring and catch
   * clauses), other variable declarations, and function/class names. Trust is
   * name-based, not scope-based, so a trusted name that is also re-bound loses
   * `receiver: 'engine'` trust for the whole file — otherwise a
   * `function query(r4)` parameter would have its `r4.filter(rows, '...')`
   * read as FHIRPath. Demotion over-corrects on purpose (a legitimate
   * module-scope `r4.filter(...)` in the same file is skipped too): a missed
   * check is the documented tradeoff, a false positive on valid code is not.
   * Distinctive `receiver: 'any'` names are unaffected — they are checked
   * even with no binding at all.
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
  return !bindings.foreign.has(receiverRoot ?? calleeName)
}

/**
 * Whether a `` fhirpath`…` `` tag is this package's, given the name it is reached
 * by. The same rule the distinctive call names get (`receiver: 'any'`): checked
 * unless that name is bound by a foreign import, so `` hb.fhirpath`…` `` under
 * `import * as hb from 'handlebars'` is not ours, while a bare tag in a file with
 * no imports still is.
 *
 * A tag is a call site in every respect but syntax, and this is the same test
 * `isCheckedCall` makes. It lives here because each walker used to hand-roll it,
 * and neither consulted the receiver — so a foreign namespaced tag was reported as
 * invalid FHIRPath, which is the failure mode this whole policy exists to avoid.
 */
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
 * The DTO root each named class of a file settles on, following `extends` chains
 * through the file's own classes. Sharing columns by extending a base DTO class is
 * the documented way to do it, and a base class carries its root along with the
 * columns it lends — so `class WeightRow extends ObservationRow` reads against
 * Observation, and its paths are checkable rather than syntax-only.
 *
 * Two guards, both because a wrong root would report valid code: a name declared
 * twice in one file is dropped rather than guessed (two scopes can hold different
 * classes of one name), and a cycle resolves to nothing. A base reached by
 * anything but a plain identifier — a factory call, an imported class — is not
 * resolvable here, and stays rootless.
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
  return {
    ...(policy.dto === true && { dto: true as const }),
    ...(inputType !== undefined && { inputType }),
  }
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
   * The plain (non-spread, non-shorthand) properties of an object literal, or
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
    // defineDto() options: { vars: { name: 'expr' }, env: { ... } }. Only vars
    // hold expressions; env holds data.
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

/**
 * Builds the function a `@column(path, options)` declaration contributes, given
 * the `fhirType` its class settled on. Both halves of the signature come from
 * `columnSignature`, the same decision the runtime registers, so the two cannot
 * drift apart. All this adds is reading the options out of the source.
 *
 * The two halves fail independently. A class whose root the file cannot
 * resolve, such as one extending an imported base or a factory call, declares
 * no input, so calls to its columns go unchecked. See `dtoRootsOf` for why
 * guessing a root is worse. An option whose value is not a literal is not in
 * the source at all, so a `collection` set from a variable drops the result
 * claim and keeps the input one.
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

/**
 * What a file's column vocabulary keeps for a field name it has already seen.
 * Two classes in one file may declare the same field name against different
 * `fhirType`s, and only one of them can register a function of that name on any
 * one engine. The source does not say which, so a claim survives only when
 * every declaration of that name agrees on it — the same answer `dtoRootsOf`
 * gives for an ambiguous class name. AGENTS.md, "The lint and editor half",
 * works through what keeping the last one seen would report.
 *
 * The two halves are judged separately, so declarations that disagree on the
 * result still declare the input type they share.
 */
export function agreedColumnDeclaration(
  seen: DeclaredColumnFunction | undefined,
  next: DeclaredColumnFunction
): DeclaredColumnFunction {
  if (seen === undefined) {
    return next
  }
  const signature = agreedSignature(seen.signature, next.signature)
  return { minArity: 0, maxArity: 0, ...(signature !== undefined && { signature }) }
}

/** The halves of two signatures that agree, or undefined when neither does. */
function agreedSignature(
  a: ColumnFunctionSignature | undefined,
  b: ColumnFunctionSignature | undefined
): ColumnFunctionSignature | undefined {
  const input = sameTypes(a?.input?.types, b?.input?.types) ? a?.input : undefined
  const result = sameResults(a?.result, b?.result) ? a?.result : undefined
  if (input === undefined && result === undefined) {
    return undefined
  }
  return { ...(input !== undefined && { input }), ...(result !== undefined && { result }) }
}

function sameResults(a: ColumnFunctionSignature['result'], b: ColumnFunctionSignature['result']): boolean {
  return a !== undefined && b !== undefined && a.single === b.single && sameTypes(a.types, b.types)
}

/** True when both sides declare the same type names in the same order. Undefined never agrees. */
function sameTypes(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  return a !== undefined && b !== undefined && a.length === b.length && a.every((type, index) => type === b[index])
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
