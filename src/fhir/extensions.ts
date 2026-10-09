import type { TypedValue } from '../values/typed-value.ts'

/** The `extension` arrays of an item: its own, and a primitive's `_field` sibling's. */
export function extensionArraysOf(item: TypedValue): unknown[][] {
  const containers: unknown[] = [item.value, item.primitiveElement]
  const result: unknown[][] = []
  for (const container of containers) {
    if (typeof container === 'object' && container !== null) {
      const extensions = (container as { extension?: unknown }).extension
      if (Array.isArray(extensions)) {
        result.push(extensions)
      }
    }
  }
  return result
}
