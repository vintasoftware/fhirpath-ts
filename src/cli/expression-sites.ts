import ts from 'typescript'

export interface ExpressionSite {
  expression: string
  /** 0-based offset of the expression text inside the file. */
  start: number
  line: number
  column: number
}

const CALL_NAMES = new Set(['fhirpath', 'compile', 'evaluate', 'analyzeExpression'])

/**
 * Find FHIRPath expression literals in a TypeScript source file: `` fhirpath`...` ``
 * tags plus literal first arguments to fhirpath()/compile()/evaluate(). Dynamic
 * expressions cannot be checked statically and are left alone.
 */
export function findExpressionSites(sourceText: string, fileName: string): ExpressionSite[] {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true)
  const foreign = foreignBindings(source)
  const sites: ExpressionSite[] = []
  const record = (text: string, literalStart: number): void => {
    const { line, character } = source.getLineAndCharacterOfPosition(literalStart)
    sites.push({ expression: text, start: literalStart, line: line + 1, column: character + 1 })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isTaggedTemplateExpression(node) && nameOf(node.tag) === 'fhirpath' && !foreign.has('fhirpath')) {
      if (ts.isNoSubstitutionTemplateLiteral(node.template)) {
        record(node.template.text, node.template.getStart(source) + 1)
      }
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const callee = nameOf(node.expression)
      const first = node.arguments[0] as ts.Expression
      if (
        callee !== undefined &&
        CALL_NAMES.has(callee) &&
        ts.isStringLiteralLike(first) &&
        !(ts.isIdentifier(node.expression) && foreign.has(callee))
      ) {
        record(first.text, first.getStart(source) + 1)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return sites
}

/**
 * Local names bound by imports from modules other than this package. `compile`
 * from handlebars is not a FHIRPath expression, so calls to those names skip
 * the check; files without imports (scripts, snippets) are always scanned.
 */
function foreignBindings(source: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>()
  for (const statement of source.statements) {
    if (!(ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier))) {
      continue
    }
    if (statement.moduleSpecifier.text.startsWith('@vinta-bb/fhirpath')) {
      continue
    }
    const clause = statement.importClause
    if (!clause) {
      continue
    }
    if (clause.name) {
      names.add(clause.name.text)
    }
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        names.add(element.name.text)
      }
    }
  }
  return names
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
