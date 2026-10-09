import type { TypedValue } from '../values/typed-value.ts'

export function extensionsOf(item: TypedValue): unknown[] {
  const containers: unknown[] = [item.value, item.primitiveElement]
  const result: unknown[] = []
  for (const container of containers) {
    if (typeof container === 'object' && container !== null) {
      const extensions = (container as { extension?: unknown }).extension
      if (Array.isArray(extensions)) {
        result.push(...extensions)
      }
    }
  }
  return result
}
