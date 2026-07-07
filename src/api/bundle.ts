import { FhirPathRuntimeError } from '../errors.ts'
import type { ModelProvider } from '../model/provider.ts'
import type { AstNode } from '../parser/ast.ts'

/** The subset of a FHIR Bundle the engine needs in order to unwrap it. */
export interface BundleLike {
  resourceType: 'Bundle'
  entry?: { resource?: unknown }[]
}

export function isBundle(value: unknown): value is BundleLike {
  return typeof value === 'object' && value !== null && (value as { resourceType?: unknown }).resourceType === 'Bundle'
}

/** One unit of work for the per-resource engine methods (`filter`, `project`, `checkConstraints`). */
export interface Subject {
  value: unknown
  /** Position in the input array or in `Bundle.entry`; absent for a single resource. */
  index?: number
}

/**
 * The per-resource view of an engine input: array items, a Bundle's entry
 * resources (original entry positions kept, entries without a resource
 * skipped), or the value itself.
 */
export function toSubjects(input: unknown): Subject[] {
  if (Array.isArray(input)) {
    return input.map((value, index) => ({ value, index }))
  }
  if (isBundle(input)) {
    return (Array.isArray(input.entry) ? input.entry : [])
      .map((entry, index) => ({ value: entry.resource, index }))
      .filter(subject => subject.value != null)
  }
  return [{ value: input }]
}

const rootIdentifiersCache = new WeakMap<AstNode, ReadonlySet<string>>()

/** Identifiers in root (path-head) position — the names that resolve against the input. */
function rootIdentifiers(ast: AstNode): ReadonlySet<string> {
  let heads = rootIdentifiersCache.get(ast)
  if (!heads) {
    const collected = new Set<string>()
    collectRootIdentifiers(ast, collected)
    rootIdentifiersCache.set(ast, collected)
    heads = collected
  }
  return heads
}

function collectRootIdentifiers(node: AstNode, heads: Set<string>): void {
  switch (node.kind) {
    case 'identifier':
      heads.add(node.name)
      return
    case 'dot':
      // Only the head of a dotted path is a root; the right side is an element name,
      // and arguments of dotted-in functions resolve against $this, not the input.
      collectRootIdentifiers(node.left, heads)
      return
    case 'indexer':
      collectRootIdentifiers(node.target, heads)
      collectRootIdentifiers(node.index, heads)
      return
    case 'call':
      for (const arg of node.args) {
        collectRootIdentifiers(arg, heads)
      }
      return
    case 'unary':
      collectRootIdentifiers(node.operand, heads)
      return
    case 'binary':
      collectRootIdentifiers(node.left, heads)
      collectRootIdentifiers(node.right, heads)
      return
    case 'typeOp':
      collectRootIdentifiers(node.operand, heads)
      return
    default:
      return
  }
}

/** Bundle element names (R4/R5 plus the Resource base), the fallback when no model is bound. */
const BUNDLE_ELEMENTS = new Set([
  'id',
  'meta',
  'implicitRules',
  'language',
  'identifier',
  'type',
  'timestamp',
  'total',
  'link',
  'entry',
  'signature',
  'issues',
])

function isBundleElement(name: string, model: ModelProvider | undefined): boolean {
  const bundleType = model?.resolveType('Bundle')
  if (model && bundleType !== undefined) {
    return model.getElement(bundleType, name) !== undefined
  }
  return BUNDLE_ELEMENTS.has(name)
}

/**
 * Bundle in, entry resources out — unless the expression addresses the Bundle
 * itself (a `Bundle` root). An expression whose root is a bare Bundle element
 * (`entry.count()`, `type`) could mean either and throws instead of guessing.
 */
export function normalizeInput(input: unknown, ast: AstNode, model: ModelProvider | undefined): unknown {
  if (!isBundle(input)) {
    return input
  }
  const heads = rootIdentifiers(ast)
  if (heads.has('Bundle')) {
    return input
  }
  for (const head of heads) {
    if (isBundleElement(head, model)) {
      throw new FhirPathRuntimeError(
        `Ambiguous expression for a Bundle input: '${head}' is a Bundle element, but a bare Bundle evaluates against its entry resources. Start the expression at Bundle to address the bundle, or wrap the input in an array to treat it as one resource.`
      )
    }
  }
  return toSubjects(input).map(subject => subject.value)
}
