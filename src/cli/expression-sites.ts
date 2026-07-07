import ts from 'typescript'
import {
  CALL_SITES,
  type CallSiteShape,
  isForeignCall,
  isForeignModule,
  TAG_NAME,
} from '../analyzer/expression-policy.ts'

export interface ExpressionSite {
  expression: string
  /** 0-based offset of the expression text inside the file. */
  start: number
  line: number
  column: number
}

/**
 * Find FHIRPath expression literals in a TypeScript source file: `` fhirpath`...` ``
 * tags, literal expression arguments to the call names in `CALL_SITES` (the
 * low-level fhirpath()/compile()/evaluate() plus the FhirPathEngine helpers —
 * including expressions inside project() columns objects and checkConstraints()
 * constraint arrays). Dynamic expressions cannot be checked statically and are
 * left alone.
 */
export function findExpressionSites(sourceText: string, fileName: string): ExpressionSite[] {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true)
  const foreign = foreignBindings(source)
  const sites: ExpressionSite[] = []
  const record = (text: string, literalStart: number): void => {
    const { line, character } = source.getLineAndCharacterOfPosition(literalStart)
    sites.push({ expression: text, start: literalStart, line: line + 1, column: character + 1 })
  }
  const recordLiteral = (literal: ts.StringLiteralLike): void => {
    record(literal.text, literal.getStart(source) + 1)
  }
  const visit = (node: ts.Node): void => {
    if (ts.isTaggedTemplateExpression(node) && nameOf(node.tag) === TAG_NAME && !foreign.has(TAG_NAME)) {
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
        !isForeignCall(foreign, callee, receiverRoot(node.expression))
      ) {
        recordArgument(argument, policy.shape, recordLiteral)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return sites
}

/** Extract the expression literal(s) an argument holds, per the call site's shape. */
function recordArgument(
  argument: ts.Expression,
  shape: CallSiteShape,
  recordLiteral: (literal: ts.StringLiteralLike) => void
): void {
  if (shape === 'expression') {
    if (ts.isStringLiteralLike(argument)) {
      recordLiteral(argument)
    }
  } else if (shape === 'columns') {
    // project() columns: { name: 'expr' } or { name: { path: 'expr', collection: true } }.
    if (ts.isObjectLiteralExpression(argument)) {
      for (const property of argument.properties) {
        if (!ts.isPropertyAssignment(property)) {
          continue
        }
        if (ts.isStringLiteralLike(property.initializer)) {
          recordLiteral(property.initializer)
        } else if (ts.isObjectLiteralExpression(property.initializer)) {
          recordProperty(property.initializer, 'path', recordLiteral)
        }
      }
    }
  } else {
    // checkConstraints() constraints: [{ key, expression: 'expr', ... }].
    if (ts.isArrayLiteralExpression(argument)) {
      for (const element of argument.elements) {
        if (ts.isObjectLiteralExpression(element)) {
          recordProperty(element, 'expression', recordLiteral)
        }
      }
    }
  }
}

/** Record an object literal's `name` property when it is a string literal. */
function recordProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
  recordLiteral: (literal: ts.StringLiteralLike) => void
): void {
  for (const property of object.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === name &&
      ts.isStringLiteralLike(property.initializer)
    ) {
      recordLiteral(property.initializer)
    }
  }
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
    if (!isForeignModule(statement.moduleSpecifier.text)) {
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

/** Leftmost identifier of a property-access callee (`Handlebars` in `Handlebars.compile`). */
function receiverRoot(callee: ts.Expression): string | undefined {
  if (!ts.isPropertyAccessExpression(callee)) {
    return undefined
  }
  let current: ts.Expression = callee.expression
  while (ts.isPropertyAccessExpression(current)) {
    current = current.expression
  }
  return ts.isIdentifier(current) ? current.text : undefined
}
