/**
 * Expression-site extraction: the shared call-site policy applied over the real
 * TypeScript AST, for every tool that reads source files — the `fhirpath-check`
 * CLI, a bundler plugin, the demo playground's editor markers. (The ESLint rule
 * is the one walker that does not use this: ESLint hands it an ESTree AST it
 * must report on.)
 *
 * Its own entry point (`fhirpath-ts/sites`) so `fhirpath-ts/analyzer` stays
 * dependency-free for the hosts that analyze *expressions* at runtime — a rules
 * editor validating what a user typed needs no compiler. Reading `.ts` source is
 * the one job that does, and even here the compiler is the caller's to provide:
 * `createSiteFinder(ts)` takes the TypeScript namespace as an argument, so the
 * CLI passes the `typescript` package (an optional peer dependency) while the
 * demo passes the copy Monaco already ships in its worker — nobody bundles a
 * second compiler. Any TypeScript >= 5 works; only stable AST API is touched.
 */
import type * as TS from 'typescript'

import {
  agreedColumnDeclaration,
  CALL_SITES,
  type ClassHeritage,
  columnFunctionDeclaration,
  constructsEngine,
  type DeclaredColumnFunction,
  DTO_BASE_NAME,
  dtoRootsOf,
  type ExpressionAst,
  expressionEntries,
  isCheckedCall,
  isCheckedTag,
  isForeignModule,
  type LocalModuleOptions,
  rootOf,
  type SiteContext,
  siteContext,
  type SourceBindings,
  TAG_NAME,
} from '../analyzer/expression-policy.ts'

/** The TypeScript API surface `createSiteFinder` needs: the namespace itself. */
export type TypeScriptApi = typeof TS

export interface ExpressionSite {
  expression: string
  /** 0-based offset of the expression text inside the file. */
  start: number
  line: number
  column: number
  /** The DTO fhirType the expression is analyzed against, when the site fixes one. */
  inputType?: string
  /** A DTO member site: its `%variables` are not the walker's to judge (see `analyzeSite`). */
  dto?: true
  /**
   * The functions the file declares: one per `@column` field, since a registered
   * DTO column is callable from any expression. Shared by every site of the
   * file, and absent when it declares none.
   */
  functions?: Readonly<Record<string, DeclaredColumnFunction>>
}

/**
 * What a site finder does: every FHIRPath expression literal in one source
 * file. `options` widens which import sources count as the real FHIRPath API
 * (LocalModuleOptions, same as the ESLint rule's).
 */
export type SiteFinder = (sourceText: string, fileName: string, options?: LocalModuleOptions) => ExpressionSite[]

/**
 * Build a site finder around the given TypeScript namespace. The finder locates
 * `` fhirpath`...` `` tags plus literal expression arguments to the call names
 * in `CALL_SITES` — including expressions inside project() columns objects,
 * checkConstraints() constraint arrays, a DTO's `vars`, and its
 * `@column`/`@criteria` fields. Which calls count, and which are skipped, is the
 * shared policy's decision — see src/analyzer/expression-policy.ts. Dynamic
 * expressions cannot be checked statically and are left alone.
 *
 * A `@column` site is analyzed against its class's fhirType, taken from the
 * class's `extends defineDto('…')` clause and threaded down the walk; a class
 * extending a base class or a root-generic factory has none. Each `@column` also
 * declares a function named by the field it decorates, so calls between a file's
 * own columns resolve.
 */
export function createSiteFinder(ts: TypeScriptApi): SiteFinder {
  /** How the shared shape extractor reads TypeScript AST nodes. */
  const tsAst: ExpressionAst<TS.Node> = {
    string: node => (ts.isStringLiteralLike(node) ? { node, expression: node.text } : undefined),
    boolean: node =>
      node.kind === ts.SyntaxKind.TrueKeyword ? true : node.kind === ts.SyntaxKind.FalseKeyword ? false : undefined,
    properties: node =>
      ts.isObjectLiteralExpression(node)
        ? node.properties
            .filter(ts.isPropertyAssignment)
            .map(property => ({ name: propertyKeyName(property.name), value: property.initializer }))
        : undefined,
    elements: node => (ts.isArrayLiteralExpression(node) ? [...node.elements] : undefined),
  }

  /** Statically-known property key (`path` in `{ path: ... }` or `{ 'path': ... }`), undefined when computed. */
  function propertyKeyName(name: TS.PropertyName): string | undefined {
    return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined
  }

  /** The name of the field a `@column(...)` decorator belongs to. */
  function decoratedFieldName(call: TS.CallExpression): string | undefined {
    const decorator = call.parent
    const member = decorator?.parent
    if (
      decorator === undefined ||
      !ts.isDecorator(decorator) ||
      member === undefined ||
      !ts.isPropertyDeclaration(member) ||
      !(ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))
    ) {
      return undefined
    }
    return member.name.text
  }

  /** A class's heritage, as `dtoRootsOf` reads it: its own DTO root, or the name of the class it extends. */
  function heritageOf(node: TS.ClassLikeDeclaration): ClassHeritage {
    const heritage: ClassHeritage = { name: node.name?.text, ownRoot: undefined, baseName: undefined }
    for (const clause of node.heritageClauses ?? []) {
      if (clause.token !== ts.SyntaxKind.ExtendsKeyword) {
        continue
      }
      for (const type of clause.types) {
        const base = type.expression
        if (ts.isCallExpression(base)) {
          if (nameOf(base.expression) === DTO_BASE_NAME) {
            const root = base.arguments[0]
            heritage.ownRoot = root === undefined ? undefined : tsAst.string(root)?.expression
          }
        } else if (ts.isIdentifier(base)) {
          heritage.baseName = base.text
        }
      }
    }
    return heritage
  }

  /**
   * Everything about the file that extraction needs to know up front, in one pass
   * over the tree: the name bindings — foreign- and package-import names from the
   * top-level import statements, then engine locals (`const engine = new
   * FhirPathEngine(...)`) and re-bound names (parameters, other declarations — see
   * `SourceBindings.rebound`) — and every class's heritage, which is what resolves
   * a DTO root through a shared base class. Collecting before extracting is what
   * lets a module-scope engine, or a base class, be used above its declaration.
   */
  function collectFile(
    source: TS.SourceFile,
    options: LocalModuleOptions
  ): {
    bindings: SourceBindings
    dtoRoots: ReadonlyMap<string, string>
    heritage: ReadonlyMap<TS.Node, ClassHeritage>
  } {
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
      if (ts.isVariableDeclaration(node)) {
        if (
          ts.isIdentifier(node.name) &&
          node.initializer !== undefined &&
          ts.isNewExpression(node.initializer) &&
          ts.isIdentifier(node.initializer.expression)
        ) {
          const set = constructsEngine(node.initializer.expression.text, bindings) ? trusted : rebound
          set.add(node.name.text)
        } else {
          // Catch clauses reach here too: `catch (r4)` is a VariableDeclaration.
          addBindingNames(node.name, rebound)
        }
      } else if (ts.isParameter(node)) {
        addBindingNames(node.name, rebound)
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
    return { bindings, dtoRoots: dtoRootsOf([...heritage.values()]), heritage }
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

  return function findExpressionSites(
    sourceText: string,
    fileName: string,
    options: LocalModuleOptions = {}
  ): ExpressionSite[] {
    const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true)
    const { bindings, dtoRoots, heritage } = collectFile(source, options)
    const sites: ExpressionSite[] = []
    const functions: Record<string, DeclaredColumnFunction> = {}
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
    const visit = (node: TS.Node, classRoot: string | undefined): void => {
      if (
        ts.isTaggedTemplateExpression(node) &&
        nameOf(node.tag) === TAG_NAME &&
        isCheckedTag(receiverRoot(node.tag), bindings)
      ) {
        if (ts.isNoSubstitutionTemplateLiteral(node.template)) {
          record(node.template.text, node.template)
        }
      } else if (ts.isCallExpression(node)) {
        const callee = nameOf(node.expression)
        const policy = callee === undefined ? undefined : CALL_SITES.get(callee)
        const argument = policy && (node.arguments[policy.argIndex] as TS.Expression | undefined)
        if (
          callee !== undefined &&
          policy !== undefined &&
          argument !== undefined &&
          isCheckedCall(policy, callee, receiverRoot(node.expression), bindings)
        ) {
          const declares = policy.declaresField
          const field = declares === undefined ? undefined : decoratedFieldName(node)
          if (declares !== undefined && field !== undefined) {
            functions[field] = agreedColumnDeclaration(
              functions[field],
              columnFunctionDeclaration<TS.Node>(declares, node.arguments[1], tsAst, classRoot)
            )
          }
          const context = siteContext<TS.Node>(policy, index => node.arguments[index], classRoot, tsAst)
          for (const entry of expressionEntries<TS.Node>(argument, policy.shape, tsAst)) {
            record(entry.expression, entry.node, context)
          }
        }
      }
      const nested = ts.isClassLike(node) ? rootOf(heritage.get(node), dtoRoots) : classRoot
      ts.forEachChild(node, child => visit(child, nested))
    }
    visit(source, undefined)
    return Object.keys(functions).length === 0 ? sites : sites.map(site => ({ ...site, functions }))
  }
}
