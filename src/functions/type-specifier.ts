import { FhirPathTypeError } from '../errors'
import type { AstNode } from '../parser/ast'

/**
 * `ofType(Quantity)`, `is(System.Boolean)`, and `as(FHIR.Patient)` receive their type
 * as an expression that parsed as an identifier or dotted identifier chain; read it
 * back as a qualified type name.
 */
export function typePartsFromArgument(functionName: string, node: AstNode): string[] {
  const parts = collect(node)
  if (!parts) {
    throw new FhirPathTypeError(`Function '${functionName}' expects a type name argument`)
  }
  return parts
}

function collect(node: AstNode): string[] | undefined {
  if (node.kind === 'identifier') {
    return [node.name]
  }
  if (node.kind === 'dot') {
    const left = collect(node.left)
    const right = node.right.kind === 'identifier' ? node.right.name : undefined
    if (left && right !== undefined) {
      return [...left, right]
    }
  }
  return undefined
}
