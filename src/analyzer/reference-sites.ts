/**
 * The reference expression-site walker: the shared policy applied over a real
 * TypeScript AST. It is the *oracle*, not a shipped code path — the ESLint rule
 * walks ESTree and everything else (the `fhirpath-check` CLI, editors, bundler
 * plugins) uses the `typescript`-free scanner in lexical-sites.ts. Keeping one
 * independent implementation is what makes the scanner trustworthy:
 * lexical-sites.test.ts runs both over every file in this repo and fails on any
 * disagreement, down to each site's DTO context.
 *
 * So: never call this from library or CLI code, and never "fix" the scanner by
 * changing this to match it.
 */
import ts from 'typescript'

import {
  CALL_SITES,
  COLUMN_NAME,
  columnFunctionDeclaration,
  constructsEngine,
  type DeclaredColumnFunction,
  DTO_BASE_NAME,
  type ExpressionAst,
  expressionEntries,
  isCheckedCall,
  isForeignModule,
  type SourceBindings,
  TAG_NAME,
} from '../analyzer/expression-policy.ts'

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

/** How the shared shape extractor reads TypeScript AST nodes. */
const tsAst: ExpressionAst<ts.Node> = {
  string: node => (ts.isStringLiteralLike(node) ? { node, expression: node.text } : undefined),
  properties: node =>
    ts.isObjectLiteralExpression(node)
      ? node.properties
          .filter(ts.isPropertyAssignment)
          .map(property => ({ name: propertyKeyName(property.name), value: property.initializer }))
      : undefined,
  elements: node => (ts.isArrayLiteralExpression(node) ? [...node.elements] : undefined),
}

/** Statically-known property key (`path` in `{ path: ... }` or `{ 'path': ... }`), undefined when computed. */
function propertyKeyName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined
}

/**
 * Find FHIRPath expression literals in a TypeScript source file: `` fhirpath`...` ``
 * tags plus literal expression arguments to the call names in `CALL_SITES` —
 * including expressions inside project() columns objects, checkConstraints()
 * constraint arrays, a DTO's `vars`, and its `@column`/`@criteria` fields. Which
 * calls count, and which are skipped, is the shared policy's decision — see
 * src/analyzer/expression-policy.ts. Dynamic expressions cannot be checked
 * statically and are left alone.
 *
 * A `@column` site is analyzed against its class's fhirType, taken from the
 * class's `extends defineDto('…')` clause and threaded down the walk; a class
 * extending a base class or a root-generic factory has none. Each `@column` also
 * declares a function named by the field it decorates, so calls between a file's
 * own columns resolve.
 */
export function findExpressionSites(sourceText: string, fileName: string): ExpressionSite[] {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true)
  const bindings = collectBindings(source)
  const sites: ExpressionSite[] = []
  const functions: Record<string, DeclaredColumnFunction> = {}
  // A site points at the first character inside the quote/backtick (node start
  // + 1), so fhirpath-check can add a diagnostic's span offsets directly. The
  // ESLint rule reports on the literal node itself, one column earlier.
  const record = (text: string, literalNode: ts.Node, context?: { inputType: string | undefined }): void => {
    const literalStart = literalNode.getStart(source) + 1
    const { line, character } = source.getLineAndCharacterOfPosition(literalStart)
    sites.push({
      expression: text,
      start: literalStart,
      line: line + 1,
      column: character + 1,
      ...(context !== undefined && { dto: true as const }),
      ...(context?.inputType !== undefined && { inputType: context.inputType }),
    })
  }
  const visit = (node: ts.Node, classRoot: string | undefined): void => {
    if (ts.isTaggedTemplateExpression(node) && nameOf(node.tag) === TAG_NAME && !bindings.foreign.has(TAG_NAME)) {
      if (ts.isNoSubstitutionTemplateLiteral(node.template)) {
        record(node.template.text, node.template)
      }
    } else if (ts.isCallExpression(node)) {
      const callee = nameOf(node.expression)
      const policy = callee === undefined ? undefined : CALL_SITES.get(callee)
      const argument = policy && (node.arguments[policy.argIndex] as ts.Expression | undefined)
      if (
        callee !== undefined &&
        policy !== undefined &&
        argument !== undefined &&
        isCheckedCall(policy, callee, receiverRoot(node.expression), bindings)
      ) {
        const inputType = policy.dtoRoot === 'argument' ? stringArgument(node.arguments[0]) : classRoot
        const field = policy.dtoRoot === 'class' && callee === COLUMN_NAME ? decoratedFieldName(node) : undefined
        if (field !== undefined) {
          functions[field] = columnFunctionDeclaration<ts.Node>(node.arguments[1], tsAst)
        }
        for (const entry of expressionEntries<ts.Node>(argument, policy.shape, tsAst)) {
          record(entry.expression, entry.node, policy.dtoRoot === undefined ? undefined : { inputType })
        }
      }
    }
    const nested = ts.isClassLike(node) ? extendedDtoRoot(node) : classRoot
    ts.forEachChild(node, child => visit(child, nested))
  }
  visit(source, undefined)
  return Object.keys(functions).length === 0 ? sites : sites.map(site => ({ ...site, functions }))
}

/** The name of the field a `@column(...)` decorator belongs to. */
function decoratedFieldName(call: ts.CallExpression): string | undefined {
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

/** The fhirType of a class's `extends defineDto('Condition', …)` clause; undefined for anything else. */
function extendedDtoRoot(node: ts.ClassLikeDeclaration): string | undefined {
  for (const clause of node.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) {
      continue
    }
    for (const type of clause.types) {
      const call = type.expression
      if (ts.isCallExpression(call) && nameOf(call.expression) === DTO_BASE_NAME) {
        return stringArgument(call.arguments[0])
      }
    }
  }
  return undefined
}

/** A call argument's text when it is a string literal. */
function stringArgument(argument: ts.Expression | undefined): string | undefined {
  return argument !== undefined && ts.isStringLiteralLike(argument) ? argument.text : undefined
}

/**
 * Collect the file's name bindings before extraction: foreign-import names and
 * package-import names from the top-level import statements, then engine locals
 * (`const engine = new FhirPathEngine(...)`) and re-bound names (parameters,
 * other declarations — see `SourceBindings.rebound`) from the whole tree — a
 * separate pass so use-before-declaration (a module-scope engine used by an
 * earlier function) still counts.
 */
function collectBindings(source: ts.SourceFile): SourceBindings {
  const foreign = new Set<string>()
  const trusted = new Set<string>()
  const rebound = new Set<string>()
  for (const statement of source.statements) {
    if (!(ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier))) {
      continue
    }
    const names = isForeignModule(statement.moduleSpecifier.text) ? foreign : trusted
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
  const collectLocals = (node: ts.Node): void => {
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
  return bindings
}

/** Add every identifier a binding name declares (`x`, `{ r4 }`, `[a, ...rest]`). */
function addBindingNames(name: ts.BindingName, into: Set<string>): void {
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

function nameOf(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node)) {
    return node.text
  }
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text
  }
  return undefined
}

/** Leftmost identifier of a member-access callee (`Handlebars` in `Handlebars.compile`). */
function receiverRoot(callee: ts.Expression): string | undefined {
  if (!ts.isPropertyAccessExpression(callee)) {
    return undefined
  }
  let current: ts.Expression = callee.expression
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = current.expression
  }
  return ts.isIdentifier(current) ? current.text : undefined
}
