/**
 * Finds FHIRPath expressions in a TypeScript AST. The caller supplies TypeScript,
 * which keeps this entry point free of runtime dependencies. The ESLint rule has
 * a separate ESTree walker that uses the same expression policy.
 */
// A default import, not `* as TS`. Under Node's ESM resolution a namespace
// import of `typescript` (a CommonJS `export =` module) carries a synthetic
// `default` property that a caller's own `import ts from 'typescript'` does not,
// so `typeof TS` would reject the very value callers pass. The default form
// names the same namespace — `TS.Node` still resolves — and accepts both.
import type TS from 'typescript'

import {
  CALL_SITES,
  callExpressionCandidates,
  type ClassFactory,
  type ClassHeritage,
  columnFunctionDeclaration,
  constructsEngine,
  declaredColumnOverloads,
  DTO_BASE_NAME,
  dtoClassesOf,
  type DtoClassFact,
  dtoClassOf,
  ENGINE_CLASS_NAME,
  type ExpressionAst,
  type ExpressionProperty,
  type FileColumnFunction,
  isCheckedCall,
  isCheckedTag,
  isForeignModule,
  type LocalModuleOptions,
  mayBeUnprovenDto,
  type SiteContext,
  type SourceBindings,
  TAG_NAME,
} from '../analyzer/expression-policy.ts'

/** The package's DTO base class export, whose `column`/`criteria` methods a type-aware scan recognizes. */
const DTO_BASE_EXPORT = 'DtoBase'

/** The TypeScript namespace accepted by `createSiteFinder`. */
export type TypeScriptApi = typeof TS

export interface ExpressionSite {
  expression: string
  /** 0-based offset of the expression text inside the file. */
  start: number
  line: number
  column: number
  /** The DTO fhirType the expression is analyzed against, when the site fixes one. */
  inputType?: string
  /** A DTO member site, which `analyzeSite` checks with source-only limits. */
  dto?: true
  /** Inline per-call environment and row-variable declarations visible to this expression. */
  variables?: NonNullable<SiteContext['variables']>
  /** Ordered per-call vars, interpreted together with loaded engine defaults by analyzeSite. */
  variablePlan?: NonNullable<SiteContext['variablePlan']>
  /** The call binds variables the source cannot name (a computed key or spread) — see `SiteContext`. */
  openVariables?: true
  /** Callable DTO columns declared in the same file. */
  functions?: Readonly<Record<string, FileColumnFunction>>
}

export interface SkippedExpressionSite {
  /** Stable reason suitable for CLI/editor policy. */
  reason: 'dynamic-expression' | 'unrecognized-receiver'
  message: string
  line: number
  column: number
}

export interface DtoSourceDeclaration {
  name: string
  line: number
  column: number
  /** True when importing the module can enumerate this class, directly or through an exported subclass. */
  loadable: boolean
}

export interface SiteScanResult {
  sites: ExpressionSite[]
  skipped: SkippedExpressionSite[]
  dtoDeclarations: DtoSourceDeclaration[]
}

/** Finds every static FHIRPath expression in one source file. */
export type SiteFinder = (sourceText: string, fileName: string, options?: LocalModuleOptions) => ExpressionSite[]

/** Scans expressions plus coverage gaps that a caller may choose to report. */
export type SiteScanner = (sourceText: string, fileName: string, options?: LocalModuleOptions) => SiteScanResult

/**
 * Creates a finder for the calls and tags in `CALL_SITES`. DTO fields include a
 * root type when the class declares one, and each column is exposed as a local
 * function declaration. Dynamic expressions are skipped.
 */
export function createSiteScanner(ts: TypeScriptApi, program?: TS.Program): SiteScanner {
  const checker = program?.getTypeChecker()
  const engineSymbolsByOptions = new Map<string, ReadonlySet<TS.Symbol>>()
  const dtoBaseSymbolsByOptions = new Map<string, ReadonlySet<TS.Symbol>>()
  /** How the shared shape extractor reads TypeScript AST nodes. */
  const tsAst: ExpressionAst<TS.Node> = {
    string: node => (ts.isStringLiteralLike(node) ? { node, expression: node.text } : undefined),
    boolean: node =>
      node.kind === ts.SyntaxKind.TrueKeyword ? true : node.kind === ts.SyntaxKind.FalseKeyword ? false : undefined,
    properties: node =>
      ts.isObjectLiteralExpression(node)
        ? node.properties.flatMap<ExpressionProperty<TS.Node>>(property => {
            if (ts.isPropertyAssignment(property)) {
              return [{ name: propertyKeyName(property.name), value: property.initializer }]
            }
            if (ts.isShorthandPropertyAssignment(property)) {
              return [{ name: property.name.text, value: property.name }]
            }
            if (ts.isSpreadAssignment(property)) {
              return [{ name: undefined, value: property.expression, spread: true as const }]
            }
            // Methods and accessors create enumerable own properties too. Their
            // values are dynamic to source analysis, but their names still make
            // env/vars scopes complete when every key is known.
            return 'name' in property ? [{ name: propertyKeyName(property.name), value: property }] : []
          })
        : undefined,
    elements: node => (ts.isArrayLiteralExpression(node) ? [...node.elements] : undefined),
  }

  /**
   * Statically-known property key: `path` in `{ path: ... }`, `{ 'path': ... }`,
   * or `{ ['path']: ... }`; undefined for other computed keys.
   */
  function propertyKeyName(name: TS.PropertyName): string | undefined {
    if (ts.isComputedPropertyName(name)) {
      return ts.isStringLiteral(name.expression) ? name.expression.text : undefined
    }
    return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined
  }

  /**
   * The public instance field a `this.<name>(...)` call initializes, when the
   * call is that field's whole initializer. Undefined for any other call shape.
   */
  function initializedFieldName(call: TS.CallExpression): string | undefined {
    const field = call.parent
    if (
      !ts.isPropertyAccessExpression(call.expression) ||
      call.expression.expression.kind !== ts.SyntaxKind.ThisKeyword ||
      field === undefined ||
      !ts.isPropertyDeclaration(field) ||
      field.initializer !== call ||
      (ts.getModifiers(field) ?? []).some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword)
    ) {
      return undefined
    }
    return ts.isPrivateIdentifier(field.name) ? undefined : propertyKeyName(field.name)
  }

  /** A class's heritage, as `dtoClassesOf` reads it. */
  function heritageOf(node: TS.ClassLikeDeclaration): ClassHeritage {
    const extended = node.heritageClauses?.find(clause => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]
    return heritageOfBase(node.name?.text, extended?.expression)
  }

  /** Reads one `extends` expression, or what a factory returns, for `dtoClassesOf`. */
  function heritageOfBase(name: string | undefined, base: TS.Expression | undefined): ClassHeritage {
    const heritage: ClassHeritage = {
      name,
      extendsDefineDto: false,
      defineDtoNamespace: undefined,
      ownRoot: undefined,
      baseName: undefined,
      baseCall: undefined,
      extendsOther: false,
    }
    if (base === undefined) {
      return heritage
    }
    if (ts.isCallExpression(base) && nameOf(base.expression) === DTO_BASE_NAME) {
      const root = base.arguments[0]
      heritage.extendsDefineDto = true
      heritage.defineDtoNamespace = receiverRoot(base.expression)
      heritage.ownRoot = root === undefined ? undefined : tsAst.string(root)?.expression
    } else if (ts.isIdentifier(base)) {
      heritage.baseName = base.text
    } else if (ts.isCallExpression(base) && ts.isIdentifier(base.expression)) {
      heritage.baseCall = base.expression.text
    } else {
      heritage.extendsOther = true
    }
    return heritage
  }

  /** What a function named `name` returns, when that is a class, a class name, or a class-building call. */
  function factoryOf(name: string, body: TS.ConciseBody | undefined): ClassFactory | undefined {
    const returned =
      body === undefined ? undefined : ts.isBlock(body) ? body.statements.find(ts.isReturnStatement)?.expression : body
    const inner = unwrapped(returned)
    if (inner !== undefined && ts.isClassExpression(inner)) {
      return { name, builds: heritageOf(inner) }
    }
    return inner !== undefined && (ts.isIdentifier(inner) || ts.isCallExpression(inner))
      ? { name, builds: heritageOfBase(undefined, inner) }
      : undefined
  }

  /** Collects imports, engine locals, rebound names, and DTO classes before extracting sites. */
  function collectFile(
    source: TS.SourceFile,
    options: LocalModuleOptions,
    engineSymbols: ReadonlySet<TS.Symbol>
  ): {
    bindings: SourceBindings
    dtoClasses: ReadonlyMap<string, DtoClassFact>
    heritage: ReadonlyMap<TS.Node, ClassHeritage>
  } {
    const factories: ClassFactory[] = []
    const foreign = new Set<string>()
    const trusted = new Set<string>()
    const rebound = new Set<string>()
    for (const statement of source.statements) {
      if (!(ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier))) {
        continue
      }
      const names = isForeignModule(statement.moduleSpecifier.text, options) ? foreign : trusted
      const clause = statement.importClause
      if (!clause) {
        continue
      }
      if (clause.name) {
        names.add(clause.name.text)
      }
      if (clause.namedBindings) {
        if (ts.isNamedImports(clause.namedBindings)) {
          for (const element of clause.namedBindings.elements) {
            names.add(element.name.text)
          }
        } else {
          names.add(clause.namedBindings.name.text)
        }
      }
    }
    const bindings = { foreign, trusted, rebound }
    const heritage = new Map<TS.Node, ClassHeritage>()
    const collectLocals = (node: TS.Node): void => {
      if (ts.isClassLike(node)) {
        heritage.set(node, heritageOf(node))
      }
      const factory =
        ts.isFunctionDeclaration(node) && node.name !== undefined
          ? factoryOf(node.name.text, node.body)
          : ts.isVariableDeclaration(node) &&
              ts.isIdentifier(node.name) &&
              node.initializer !== undefined &&
              (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
            ? factoryOf(node.name.text, node.initializer.body)
            : undefined
      if (factory !== undefined) {
        factories.push(factory)
      }
      if (ts.isVariableDeclaration(node)) {
        if (
          ts.isIdentifier(node.name) &&
          node.initializer !== undefined &&
          ts.isNewExpression(node.initializer) &&
          ts.isIdentifier(node.initializer.expression)
        ) {
          const set = constructsEngine(node.initializer.expression.text, bindings) ? trusted : rebound
          set.add(node.name.text)
        } else if (ts.isIdentifier(node.name) && isEngineExpression(node.name, engineSymbols)) {
          trusted.add(node.name.text)
          foreign.delete(node.name.text)
        } else {
          // Catch clauses reach here too: `catch (r4)` is a VariableDeclaration.
          addBindingNames(node.name, rebound)
        }
      } else if (ts.isParameter(node)) {
        if (ts.isIdentifier(node.name) && isEngineExpression(node.name, engineSymbols)) {
          trusted.add(node.name.text)
          foreign.delete(node.name.text)
        } else {
          addBindingNames(node.name, rebound)
        }
      } else if (
        (ts.isFunctionDeclaration(node) ||
          ts.isFunctionExpression(node) ||
          ts.isClassDeclaration(node) ||
          ts.isClassExpression(node)) &&
        node.name !== undefined
      ) {
        rebound.add(node.name.text)
      }
      ts.forEachChild(node, collectLocals)
    }
    collectLocals(source)
    return { bindings, dtoClasses: dtoClassesOf([...heritage.values()], bindings, factories), heritage }
  }

  /** Package engine declarations reached through a real `fhirpath-ts` import. */
  function collectTrustedEngineSymbols(options: LocalModuleOptions): ReadonlySet<TS.Symbol> {
    const symbols = new Set<TS.Symbol>()
    if (checker === undefined || program === undefined) {
      return symbols
    }
    const resolvedSymbol = (initial: TS.Symbol | undefined): TS.Symbol | undefined => {
      let symbol = initial
      const seen = new Set<TS.Symbol>()
      while (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(symbol)) {
        seen.add(symbol)
        symbol = checker.getAliasedSymbol(symbol)
      }
      return symbol
    }
    const resolved = (node: TS.Node): TS.Symbol | undefined => resolvedSymbol(checker.getSymbolAtLocation(node))
    for (const source of program.getSourceFiles()) {
      for (const statement of source.statements) {
        if (
          !ts.isImportDeclaration(statement) ||
          !ts.isStringLiteral(statement.moduleSpecifier) ||
          isForeignModule(statement.moduleSpecifier.text, options)
        ) {
          continue
        }
        const bindings = statement.importClause?.namedBindings
        if (bindings === undefined) {
          continue
        }
        if (ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            if ((element.propertyName ?? element.name).text === ENGINE_CLASS_NAME) {
              const symbol = resolved(element.name)
              if (symbol !== undefined) {
                symbols.add(symbol)
              }
            }
          }
          continue
        }
        const module = resolved(bindings.name)
        const symbol =
          module === undefined
            ? undefined
            : checker.getExportsOfModule(module).find(entry => entry.name === ENGINE_CLASS_NAME)
        if (symbol !== undefined) {
          symbols.add(resolvedSymbol(symbol) ?? symbol)
        }
      }
    }
    return symbols
  }

  function engineSymbolsFor(options: LocalModuleOptions): ReadonlySet<TS.Symbol> {
    const key = JSON.stringify({ packages: options.packages, localImports: options.localImports === true })
    const cached = engineSymbolsByOptions.get(key)
    if (cached !== undefined) {
      return cached
    }
    const symbols = collectTrustedEngineSymbols(options)
    engineSymbolsByOptions.set(key, symbols)
    return symbols
  }

  /** This package's DTO base class, reached through any real `fhirpath-ts` import in the program. */
  function dtoBaseSymbolsFor(options: LocalModuleOptions): ReadonlySet<TS.Symbol> {
    const key = JSON.stringify({ packages: options.packages, localImports: options.localImports === true })
    const cached = dtoBaseSymbolsByOptions.get(key)
    if (cached !== undefined) {
      return cached
    }
    const symbols = new Set<TS.Symbol>()
    for (const source of program?.getSourceFiles() ?? []) {
      for (const statement of source.statements) {
        if (
          !ts.isImportDeclaration(statement) ||
          !ts.isStringLiteral(statement.moduleSpecifier) ||
          isForeignModule(statement.moduleSpecifier.text, options)
        ) {
          continue
        }
        const module = checker?.getSymbolAtLocation(statement.moduleSpecifier)
        const exported = module === undefined ? undefined : checker?.getExportsOfModule(module)
        const base = exported?.find(entry => entry.name === DTO_BASE_EXPORT)
        if (base !== undefined) {
          symbols.add((base.flags & ts.SymbolFlags.Alias) !== 0 ? checker!.getAliasedSymbol(base) : base)
        }
      }
    }
    dtoBaseSymbolsByOptions.set(key, symbols)
    return symbols
  }

  /**
   * What TypeScript proves about a `this.<name>(...)` call the source could not:
   * the method is this package's DTO base method, and the class's fhirType when
   * it is a literal. Undefined without a program or for any other method.
   */
  function dtoFactFromTypes(
    callee: TS.PropertyAccessExpression,
    options: LocalModuleOptions
  ): DtoClassFact | undefined {
    if (checker === undefined) {
      return undefined
    }
    const declaration = checker.getSymbolAtLocation(callee.name)?.declarations?.[0]
    const owner = declaration?.parent
    const ownerSymbol =
      owner !== undefined && ts.isClassDeclaration(owner) && owner.name !== undefined
        ? checker.getSymbolAtLocation(owner.name)
        : undefined
    if (ownerSymbol === undefined || !dtoBaseSymbolsFor(options).has(ownerSymbol)) {
      return undefined
    }
    const fhirType = checker.getTypeAtLocation(callee.expression).getProperty('fhirType')
    const root = fhirType === undefined ? undefined : checker.getTypeOfSymbolAtLocation(fhirType, callee)
    return { root: root?.isStringLiteral() === true ? root.value : undefined }
  }

  /** Whether TypeScript resolved an expression to this package's engine class. */
  function isEngineExpression(node: TS.Expression, engineSymbols: ReadonlySet<TS.Symbol>): boolean {
    if (checker === undefined || engineSymbols.size === 0 || node.getSourceFile().isDeclarationFile) {
      return false
    }
    const hasEngineSymbol = (type: TS.Type, seen: Set<TS.Type>): boolean => {
      if (seen.has(type)) {
        return false
      }
      seen.add(type)
      if (type.isUnion()) {
        return type.types.length > 0 && type.types.every(member => hasEngineSymbol(member, new Set(seen)))
      }
      if (type.isIntersection()) {
        return type.types.some(member => hasEngineSymbol(member, new Set(seen)))
      }
      const symbol = type.aliasSymbol ?? type.getSymbol()
      if (symbol !== undefined && engineSymbols.has(symbol)) {
        return true
      }
      const constraint = checker.getBaseConstraintOfType(type)
      if (constraint !== undefined && constraint !== type && hasEngineSymbol(constraint, seen)) {
        return true
      }
      if ((type.flags & ts.TypeFlags.Object) === 0) {
        return false
      }
      const object = type as TS.ObjectType
      if ((object.objectFlags & (ts.ObjectFlags.Class | ts.ObjectFlags.Interface | ts.ObjectFlags.Reference)) === 0) {
        return false
      }
      return checker.getBaseTypes(type as TS.InterfaceType).some(base => hasEngineSymbol(base, seen))
    }
    return hasEngineSymbol(checker.getTypeAtLocation(node), new Set())
  }

  /** An unresolved receiver may still be an engine; a resolved non-engine is not our call site. */
  function shouldReportUnrecognized(node: TS.Expression): boolean {
    if (checker === undefined || node.getSourceFile().isDeclarationFile) {
      return true
    }
    const flags = checker.getTypeAtLocation(node).flags
    return (flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0
  }

  /** Add every identifier a binding name declares (`x`, `{ r4 }`, `[a, ...rest]`). */
  function addBindingNames(name: TS.BindingName, into: Set<string>): void {
    if (ts.isIdentifier(name)) {
      into.add(name.text)
      return
    }
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) {
        addBindingNames(element.name, into)
      }
    }
  }

  function nameOf(node: TS.Expression): string | undefined {
    if (ts.isIdentifier(node)) {
      return node.text
    }
    if (ts.isPropertyAccessExpression(node)) {
      return node.name.text
    }
    return undefined
  }

  /** Leftmost identifier of a member-access callee (`Handlebars` in `Handlebars.compile`). */
  function receiverRoot(callee: TS.Expression): string | undefined {
    if (!ts.isPropertyAccessExpression(callee)) {
      return undefined
    }
    let current: TS.Expression = callee.expression
    while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      current = current.expression
    }
    return ts.isIdentifier(current) ? current.text : undefined
  }

  /** Strips source wrappers that keep an expression's runtime identity. */
  function unwrapped(node: TS.Expression | undefined): TS.Expression | undefined {
    let current = node
    while (
      current !== undefined &&
      (ts.isParenthesizedExpression(current) ||
        ts.isAsExpression(current) ||
        ts.isSatisfiesExpression(current) ||
        ts.isTypeAssertionExpression(current) ||
        ts.isNonNullExpression(current))
    ) {
      current = current.expression
    }
    return current
  }

  /** Class bindings made reachable by one immutable initializer or default export. */
  function bindingTargets(node: TS.Expression | undefined): string[] {
    const target = unwrapped(node)
    if (target === undefined) {
      return []
    }
    if (ts.isIdentifier(target)) {
      return [target.text]
    }
    if (!ts.isClassExpression(target)) {
      return []
    }
    // A class expression's own name is scoped to its body, not a reference to a
    // same-named top-level class. Only its base can expose another declaration.
    const { baseName } = heritageOf(target)
    return baseName === undefined ? [] : [baseName]
  }

  /**
   * The module's exported names, plus what each top-level `const` binding stands
   * for: `export const Row = ProblemRow` makes the loader enumerate `Row`, so
   * `ProblemRow` is reachable through it — directly, through an alias chain, or
   * as the base of an exported anonymous class expression.
   */
  function moduleBindings(source: TS.SourceFile): {
    exported: ReadonlySet<string>
    aliases: ReadonlyMap<string, readonly string[]>
  } {
    const exported = new Set<string>()
    const aliases = new Map<string, string[]>()
    const addAlias = (from: string, to: string): void => {
      const edges = aliases.get(from)
      if (edges === undefined) {
        aliases.set(from, [to])
      } else {
        edges.push(to)
      }
    }
    const isExported = (statement: TS.Statement): boolean =>
      (ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : []).some(
        modifier => modifier.kind === ts.SyntaxKind.ExportKeyword
      )
    for (const statement of source.statements) {
      if (ts.isClassDeclaration(statement) && isExported(statement)) {
        if (statement.name !== undefined) {
          exported.add(statement.name.text)
        } else {
          // `export default class extends Base {}`: the loader gets the class,
          // so its base is reachable even though neither has a bound name here.
          const base = heritageOf(statement).baseName
          if (base !== undefined) {
            exported.add(base)
          }
        }
      } else if (ts.isVariableStatement(statement)) {
        const immutable = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name)) {
            continue
          }
          const name = declaration.name.text
          if (isExported(statement)) {
            exported.add(name)
          }
          if (immutable) {
            for (const target of bindingTargets(declaration.initializer)) {
              addAlias(name, target)
            }
          }
        }
      } else if (
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier === undefined &&
        statement.isTypeOnly === false &&
        statement.exportClause !== undefined
      ) {
        if (ts.isNamedExports(statement.exportClause)) {
          for (const element of statement.exportClause.elements) {
            if (!element.isTypeOnly) {
              exported.add((element.propertyName ?? element.name).text)
            }
          }
        }
      } else if (ts.isExportAssignment(statement)) {
        for (const target of bindingTargets(statement.expression)) {
          exported.add(target)
        }
      }
    }
    return { exported, aliases }
  }

  return function scanExpressionSites(
    sourceText: string,
    fileName: string,
    options: LocalModuleOptions = {}
  ): SiteScanResult {
    const programSource = program?.getSourceFile(fileName)
    const source =
      programSource !== undefined && programSource.text === sourceText
        ? programSource
        : ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true)
    const engineSymbols = engineSymbolsFor(options)
    const { bindings, dtoClasses, heritage } = collectFile(source, options, engineSymbols)
    const classNames = new Set([...heritage.values()].flatMap(cls => (cls.name === undefined ? [] : [cls.name])))
    const sites: ExpressionSite[] = []
    const skipped: SkippedExpressionSite[] = []
    const columnClasses = new Set<TS.ClassLikeDeclaration>()
    const functions: Record<string, FileColumnFunction> = {}
    // A site points at the first character inside the quote/backtick (node start
    // + 1), so fhirpath-check can add a diagnostic's span offsets directly. The
    // ESLint rule reports on the literal node itself, one column earlier.
    const record = (text: string, literalNode: TS.Node, context: SiteContext = {}): void => {
      const literalStart = literalNode.getStart(source) + 1
      const { line, character } = source.getLineAndCharacterOfPosition(literalStart)
      sites.push({
        expression: text,
        start: literalStart,
        line: line + 1,
        column: character + 1,
        ...context,
      })
    }
    const skip = (node: TS.Node, reason: SkippedExpressionSite['reason'], message: string): void => {
      const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source))
      skipped.push({ reason, message, line: line + 1, column: character + 1 })
    }
    const visit = (
      node: TS.Node,
      dtoClass: DtoClassFact | undefined,
      enclosingClass: TS.ClassLikeDeclaration | undefined
    ): void => {
      if (ts.isTaggedTemplateExpression(node) && nameOf(node.tag) === TAG_NAME) {
        if (!isCheckedTag(receiverRoot(node.tag), bindings)) {
          if (shouldReportUnrecognized(node.tag)) {
            skip(node.tag, 'unrecognized-receiver', 'FHIRPath tag not analyzed: its binding is not from fhirpath-ts')
          }
        } else if (ts.isNoSubstitutionTemplateLiteral(node.template)) {
          record(node.template.text, node.template)
        } else {
          skip(node.template, 'dynamic-expression', 'FHIRPath template not analyzed: substitutions make it dynamic')
        }
      } else if (ts.isCallExpression(node)) {
        const callee = nameOf(node.expression)
        const policy = callee === undefined ? undefined : CALL_SITES.get(callee)
        const argument = policy && (node.arguments[policy.argIndex] as TS.Expression | undefined)
        const field = policy?.receiver === 'dto-field' ? initializedFieldName(node) : undefined
        // A DTO the source cannot prove may still be one the types can.
        const columnClass =
          field === undefined
            ? undefined
            : (dtoClass ?? dtoFactFromTypes(node.expression as TS.PropertyAccessExpression, options))
        if (callee !== undefined && policy !== undefined && argument !== undefined) {
          const typedEngineReceiver =
            ts.isPropertyAccessExpression(node.expression) &&
            isEngineExpression(node.expression.expression, engineSymbols)
          const checked = isCheckedCall(policy, callee, receiverRoot(node.expression), bindings, {
            ...(typedEngineReceiver && { engine: true }),
            ...(columnClass !== undefined && { dtoField: true }),
          })
          if (policy.receiver === 'dto-field') {
            if (!checked && field !== undefined && mayBeUnprovenDto(heritage.get(enclosingClass!), classNames)) {
              const unresolved =
                checker === undefined ||
                checker.getSymbolAtLocation((node.expression as TS.PropertyAccessExpression).name) === undefined
              if (unresolved) {
                skip(
                  node.expression,
                  'unrecognized-receiver',
                  `${callee}(...) expression not analyzed: the class is not recognized as a DTO`
                )
              }
            }
          } else if (!checked) {
            const receiver = receiverRoot(node.expression)
            const receiverExpression = ts.isPropertyAccessExpression(node.expression)
              ? node.expression.expression
              : node.expression
            if (shouldReportUnrecognized(receiverExpression)) {
              skip(
                node.expression,
                'unrecognized-receiver',
                `${callee}(...) expression not analyzed: ${
                  receiver === undefined
                    ? `binding '${callee}' is not recognized as fhirpath-ts`
                    : `receiver '${receiver}' is not recognized as a FhirPathEngine`
                }`
              )
            }
          }
          if (checked) {
            const declares = policy.declaresField
            if (declares !== undefined && field !== undefined) {
              if (enclosingClass !== undefined) {
                columnClasses.add(enclosingClass)
              }
              functions[field] = declaredColumnOverloads(
                functions[field],
                columnFunctionDeclaration<TS.Node>(declares, node.arguments[1], tsAst, columnClass?.root)
              )
            }
            for (const candidate of callExpressionCandidates<TS.Node>(
              policy,
              index => node.arguments[index],
              columnClass?.root,
              tsAst
            )) {
              if (candidate.uncheckable === 'dynamic-vars') {
                skip(
                  candidate.node,
                  'dynamic-expression',
                  `${callee}(...) var expressions not analyzed: their final names, values, or order are dynamic`
                )
              } else if (candidate.expression === undefined) {
                skip(
                  candidate.node,
                  'dynamic-expression',
                  candidate.source === 'option-var'
                    ? `${callee}(...) var expression not analyzed: it is not a string literal`
                    : `${callee}(...) expression not analyzed: it is not a string literal`
                )
              } else {
                record(candidate.expression, candidate.node, candidate.context)
              }
            }
          }
        }
      }
      const nested = ts.isClassLike(node) ? dtoClassOf(heritage.get(node), dtoClasses, bindings) : dtoClass
      const nestedClass = ts.isClassLike(node) ? node : enclosingClass
      ts.forEachChild(node, child => visit(child, nested, nestedClass))
    }
    visit(source, undefined, undefined)
    const { exported, aliases } = moduleBindings(source)
    const classByName = new Map(
      [...heritage.entries()].flatMap(([node, value]) =>
        ts.isClassLike(node) && value.name !== undefined ? [[value.name, value] as const] : []
      )
    )
    // From every exported binding, follow alias and extends edges: what the
    // loader enumerates under any name makes every class behind it analyzable.
    const reachesExport = (name: string): boolean => {
      const seen = new Set<string>()
      const frontier = [...exported]
      while (frontier.length > 0) {
        const current = frontier.pop() as string
        if (current === name) {
          return true
        }
        if (seen.has(current)) {
          continue
        }
        seen.add(current)
        const base = classByName.get(current)?.baseName
        if (base !== undefined) {
          frontier.push(base)
        }
        frontier.push(...(aliases.get(current) ?? []))
      }
      return false
    }
    const dtoDeclarations = [...columnClasses].flatMap(node => {
      const nameNode = node.name
      // Runtime module discovery can only miss top-level module-local classes.
      // A class inside a factory is reached through whatever class the factory
      // returns, rather than as a module export with its source name.
      if (nameNode === undefined || node.parent !== source) {
        return []
      }
      const name = nameNode.text
      const { line, character } = source.getLineAndCharacterOfPosition(nameNode.getStart(source))
      return [{ name, line: line + 1, column: character + 1, loadable: reachesExport(name) }]
    })
    return {
      sites: Object.keys(functions).length === 0 ? sites : sites.map(site => ({ ...site, functions })),
      skipped,
      dtoDeclarations,
    }
  }
}

/** Creates the compatibility finder that returns only expressions successfully extracted. */
export function createSiteFinder(ts: TypeScriptApi, program?: TS.Program): SiteFinder {
  const scan = createSiteScanner(ts, program)
  return (sourceText, fileName, options) => scan(sourceText, fileName, options).sites
}
