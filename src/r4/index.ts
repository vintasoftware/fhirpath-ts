import type { ElementInfo, ModelProvider } from '../model/provider.ts'
import { R4_RESOURCES } from './generated/resources-data.ts'
import { R4_DATA_TYPES } from './generated/types-data.ts'
import type { GeneratedElement, GeneratedType } from './model-data.ts'

// One canonical FHIR-primitive → System map lives in values/typed-value.ts;
// re-exported here because the model subpath is where consumers look for it.
export { FHIR_PRIMITIVE_TO_SYSTEM as PRIMITIVE_TO_SYSTEM } from '../values/typed-value.ts'
export type { GeneratedElement, GeneratedType } from './model-data.ts'

const NAMESPACE = 'FHIR'
const PREFIX = `${NAMESPACE}.`

function lookupType(name: string): GeneratedType | undefined {
  return R4_RESOURCES[name] ?? R4_DATA_TYPES[name]
}

function localName(canonical: string): string {
  return canonical.startsWith(PREFIX) ? canonical.slice(PREFIX.length) : canonical
}

/**
 * Walk a type and its ancestors for an element. Backbone elements are typed by
 * their path (`Patient.contact`), which is itself a key in the generated tables.
 */
function findElement(typeName: string, element: string): GeneratedElement | undefined {
  let current: string | undefined = typeName
  const visited = new Set<string>()
  while (current !== undefined && !visited.has(current)) {
    visited.add(current)
    const definition = lookupType(current)
    if (!definition) {
      return undefined
    }
    const found: GeneratedElement | undefined = definition.e[element]
    if (found) {
      return found
    }
    current = definition.b
  }
  return undefined
}

/** The generated R4 model: type resolution, element lookup, and the type hierarchy. */
export const r4Model: ModelProvider = {
  namespace: NAMESPACE,

  resolveType(name: string): string | undefined {
    return lookupType(name) ? `${PREFIX}${name}` : undefined
  },

  getElement(type: string, element: string): ElementInfo | undefined {
    const found = findElement(localName(type), element)
    if (!found) {
      return undefined
    }
    return { types: found.t, isCollection: found.a === 1, isChoice: found.c === 1 }
  },

  listElements(type: string): string[] | undefined {
    let current: string | undefined = localName(type)
    if (!lookupType(current)) {
      return undefined
    }
    const names: string[] = []
    const seen = new Set<string>()
    const visited = new Set<string>()
    while (current !== undefined && !visited.has(current)) {
      visited.add(current)
      const definition = lookupType(current)
      if (!definition) {
        break
      }
      for (const name of Object.keys(definition.e)) {
        if (!seen.has(name)) {
          seen.add(name)
          names.push(name)
        }
      }
      current = definition.b
    }
    return names
  },

  isSubtypeOf(type: string, base: string): boolean {
    const target = localName(base)
    let current: string | undefined = localName(type)
    const visited = new Set<string>()
    while (current !== undefined && !visited.has(current)) {
      if (current === target) {
        return true
      }
      visited.add(current)
      current = lookupType(current)?.b
    }
    return false
  },
}
