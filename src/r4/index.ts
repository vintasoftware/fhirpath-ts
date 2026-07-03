import type { ElementInfo, ModelProvider } from '../model/provider.ts'
import { R4_RESOURCES } from './generated/resources-data.ts'
import { R4_DATA_TYPES } from './generated/types-data.ts'
import type { GeneratedElement, GeneratedType } from './model-data.ts'

export type { GeneratedElement, GeneratedType } from './model-data.ts'

/** FHIR primitive type names to their System twins (FHIR spec "types" page). */
export const PRIMITIVE_TO_SYSTEM: Readonly<Record<string, string>> = {
  boolean: 'System.Boolean',
  integer: 'System.Integer',
  positiveInt: 'System.Integer',
  unsignedInt: 'System.Integer',
  integer64: 'System.Long',
  decimal: 'System.Decimal',
  date: 'System.Date',
  dateTime: 'System.DateTime',
  instant: 'System.DateTime',
  time: 'System.Time',
  string: 'System.String',
  code: 'System.String',
  id: 'System.String',
  markdown: 'System.String',
  uri: 'System.String',
  url: 'System.String',
  canonical: 'System.String',
  oid: 'System.String',
  uuid: 'System.String',
  base64Binary: 'System.String',
  xhtml: 'System.String',
}

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
