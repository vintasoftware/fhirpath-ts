import { FhirPathEngine } from '../api/engine.ts'
import type { ElementInfo, ModelProvider } from '../model/provider.ts'
import { R4_RESOURCES_COMPACT } from './generated/resources-data.ts'
import { R4_DATA_TYPES_COMPACT } from './generated/types-data.ts'
import { CompactTypeTable, type GeneratedElement, type GeneratedType } from './model-data.ts'

// One canonical FHIR-primitive → System map lives in values/typed-value.ts;
// re-exported here because the model subpath is where consumers look for it.
export { FHIR_PRIMITIVE_TO_SYSTEM as PRIMITIVE_TO_SYSTEM } from '../values/typed-value.ts'
export type { GeneratedElement, GeneratedType } from './model-data.ts'

const NAMESPACE = 'FHIR'
const PREFIX = `${NAMESPACE}.`

const RESOURCES = new CompactTypeTable(R4_RESOURCES_COMPACT)
const DATA_TYPES = new CompactTypeTable(R4_DATA_TYPES_COMPACT)

function lookupType(name: string): GeneratedType | undefined {
  return RESOURCES.get(name) ?? DATA_TYPES.get(name)
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
    return {
      types: found.t,
      isCollection: found.a === 1,
      isChoice: found.c === 1,
      ...(found.r !== undefined && { referenceTargets: found.r }),
    }
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
    // The tables carry each inherited element only on the type that declares
    // it, so the walk yields own elements before inherited ones; sorting gives
    // callers one stable order independent of where an element is declared.
    return names.sort()
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

/** A ready-made engine with the R4 model bound: `r4.evaluate('Patient.name.given', patient)`. */
export const r4 = new FhirPathEngine({ model: r4Model })
