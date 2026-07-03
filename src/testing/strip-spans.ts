import type { AstNode } from '../parser/ast.ts'

/** Drop `span` fields recursively so structural AST assertions stay readable. */
export function stripSpans(node: AstNode): unknown {
  return JSON.parse(JSON.stringify(node, (key, value: unknown) => (key === 'span' ? undefined : value)))
}
