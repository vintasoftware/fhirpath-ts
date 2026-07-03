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
  const sites: ExpressionSite[] = []
  const record = (text: string, literalStart: number): void => {
    const { line, character } = source.getLineAndCharacterOfPosition(literalStart)
    sites.push({ expression: text, start: literalStart, line: line + 1, column: character + 1 })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isTaggedTemplateExpression(node) && nameOf(node.tag) === 'fhirpath') {
      if (ts.isNoSubstitutionTemplateLiteral(node.template)) {
        record(node.template.text, node.template.getStart(source) + 1)
      }
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const callee = nameOf(node.expression)
      const first = node.arguments[0] as ts.Expression
      if (callee !== undefined && CALL_NAMES.has(callee) && ts.isStringLiteralLike(first)) {
        record(first.text, first.getStart(source) + 1)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return sites
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
