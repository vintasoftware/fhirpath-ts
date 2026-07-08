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
 * constraint arrays. Which calls count is the shared policy's decision
 * (`isCheckedCall`): foreign imports are skipped, and the common-name engine
 * helpers (test/filter/first/project) fire only on receivers bound to this
 * package or to a `new FhirPathEngine(...)` local. Dynamic expressions cannot
 * be checked statically and are left alone.
 */
export function findExpressionSites(sourceText: string, fileName: string): ExpressionSite[] {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true)
  const bindings = collectBindings(source)
  const sites: ExpressionSite[] = []
  const record = (text: string, literalStart: number): void => {
    const { line, character } = source.getLineAndCharacterOfPosition(literalStart)
    sites.push({ expression: text, start: literalStart, line: line + 1, column: character + 1 })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isTaggedTemplateExpression(node) && nameOf(node.tag) === TAG_NAME && !bindings.foreign.has(TAG_NAME)) {
      if (ts.isNoSubstitutionTemplateLiteral(node.template)) {
        record(node.template.text, node.template.getStart(source) + 1)
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
          record(entry.expression, entry.node.getStart(source) + 1)
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
 * (`const engine = new FhirPathEngine(...)`) from the whole tree — a separate
 * pass so use-before-declaration (a module-scope engine used by an earlier
 * function) still counts.
 */
function collectBindings(source: ts.SourceFile): SourceBindings {
  const foreign = new Set<string>()
  const engines = new Set<string>()
  for (const statement of source.statements) {
    if (!(ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier))) {
      continue
    }
    const names = isForeignModule(statement.moduleSpecifier.text) ? foreign : engines
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
  const bindings = { foreign, engines }
  const collectEngineLocals = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isNewExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      constructsEngine(node.initializer.expression.text, bindings)
    ) {
      engines.add(node.name.text)
    }
    ts.forEachChild(node, collectEngineLocals)
  }
  collectEngineLocals(source)
  return bindings
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
