import ts from 'typescript'
import {
  CALL_SITES,
  constructsEngine,
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
 * including expressions inside project() columns objects and checkConstraints()
 * constraint arrays. Which calls count, and which are skipped, is the shared
 * policy's decision — see src/analyzer/expression-policy.ts. Dynamic expressions
 * cannot be checked statically and are left alone.
 */
export function findExpressionSites(sourceText: string, fileName: string): ExpressionSite[] {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true)
  const bindings = collectBindings(source)
  const sites: ExpressionSite[] = []
  // A site points at the first character inside the quote/backtick (node start
  // + 1), so fhirpath-check can add a diagnostic's span offsets directly. The
  // ESLint rule reports on the literal node itself, one column earlier.
  const record = (text: string, literalNode: ts.Node): void => {
    const literalStart = literalNode.getStart(source) + 1
    const { line, character } = source.getLineAndCharacterOfPosition(literalStart)
    sites.push({ expression: text, start: literalStart, line: line + 1, column: character + 1 })
  }
  const visit = (node: ts.Node): void => {
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
        for (const entry of expressionEntries<ts.Node>(argument, policy.shape, tsAst)) {
          record(entry.expression, entry.node)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return sites
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
