/** Shapes of the generated R4 model data (see scripts/generate-r4-model.ts). */
export interface GeneratedElement {
  /** Element types; several entries for choice elements (`value[x]`). */
  t: string[]
  /** Present (1) when max cardinality is above 1. */
  a?: 1
  /** Present (1) for choice elements: JSON keys carry a type suffix (valueQuantity). */
  c?: 1
  /** Resource names a Reference element may point to (targetProfile); absent when unconstrained. */
  r?: string[]
}

export interface GeneratedType {
  /** Base type local name, absent for the roots (Base, Element). */
  b?: string
  e: Record<string, GeneratedElement>
}

/**
 * The generated tables ship as one compact string instead of an object literal:
 * the string is smaller to download and cheaper to decode than a large literal
 * is to parse, and `CompactTypeTable` decodes one type at a time so only the
 * types an application touches are ever materialized.
 *
 * Format, one line per type:
 *
 *     Name|Base|element:type1,type2*^<Target1,Target2;element2:type
 *
 * `*` marks a collection (`a: 1`), `^` a choice element (`c: 1`), and `<`
 * starts the Reference target list (`r`). An empty Base segment means the type
 * has no base. Elements identical to the nearest ancestor's entry are omitted
 * by the generator; lookups walk the base chain (see index.ts).
 */
const RESERVED_IN_COMPACT = /[|;:,*^<\n\\`$]/

function assertCompactSafe(name: string): string {
  if (RESERVED_IN_COMPACT.test(name)) {
    throw new Error(`name contains a character reserved by the compact model encoding: ${name}`)
  }
  return name
}

/** Encodes a generated table into the compact string form (generator-side; see the format above). */
export function encodeCompactTypes(types: Record<string, GeneratedType>): string {
  const lines: string[] = []
  for (const [name, type] of Object.entries(types)) {
    const elements = Object.entries(type.e).map(([element, info]) => {
      let entry = `${assertCompactSafe(element)}:${info.t.map(assertCompactSafe).join(',')}`
      if (info.a === 1) {
        entry += '*'
      }
      if (info.c === 1) {
        entry += '^'
      }
      if (info.r !== undefined) {
        entry += `<${info.r.map(assertCompactSafe).join(',')}`
      }
      return entry
    })
    lines.push(`${assertCompactSafe(name)}|${assertCompactSafe(type.b ?? '')}|${elements.join(';')}`)
  }
  return lines.join('\n')
}

/** Decodes the segment after the second `|` of a line. */
function decodeTypeLine(line: string): GeneratedType {
  const baseStart = line.indexOf('|') + 1
  const baseEnd = line.indexOf('|', baseStart)
  const base = line.slice(baseStart, baseEnd)
  const e: Record<string, GeneratedElement> = {}
  const body = line.slice(baseEnd + 1)
  if (body !== '') {
    for (const entry of body.split(';')) {
      const colon = entry.indexOf(':')
      const name = entry.slice(0, colon)
      let rest = entry.slice(colon + 1)
      const element: GeneratedElement = { t: [] }
      const targetsStart = rest.indexOf('<')
      if (targetsStart >= 0) {
        element.r = rest.slice(targetsStart + 1).split(',')
        rest = rest.slice(0, targetsStart)
      }
      if (rest.endsWith('^')) {
        element.c = 1
        rest = rest.slice(0, -1)
      }
      if (rest.endsWith('*')) {
        element.a = 1
        rest = rest.slice(0, -1)
      }
      element.t = rest.split(',')
      e[name] = element
    }
  }
  return base === '' ? { e } : { b: base, e }
}

/** Eagerly decodes a whole table; for build scripts, not the runtime path. */
export function decodeCompactTypes(encoded: string): Record<string, GeneratedType> {
  const types: Record<string, GeneratedType> = {}
  for (const line of encoded.split('\n')) {
    types[line.slice(0, line.indexOf('|'))] = decodeTypeLine(line)
  }
  return types
}

/**
 * Lazy view over a compact-encoded table. The line index is built on first
 * lookup and each type is decoded once, on demand, so importing the model costs
 * almost nothing until an expression actually navigates it.
 */
export class CompactTypeTable {
  private readonly encoded: string
  private index: Map<string, string> | undefined
  private readonly decoded = new Map<string, GeneratedType>()

  constructor(encoded: string) {
    this.encoded = encoded
  }

  get(name: string): GeneratedType | undefined {
    const cached = this.decoded.get(name)
    if (cached !== undefined) {
      return cached
    }
    const line = this.lines().get(name)
    if (line === undefined) {
      return undefined
    }
    const type = decodeTypeLine(line)
    this.decoded.set(name, type)
    return type
  }

  private lines(): Map<string, string> {
    if (this.index === undefined) {
      this.index = new Map()
      for (const line of this.encoded.split('\n')) {
        this.index.set(line.slice(0, line.indexOf('|')), line)
      }
    }
    return this.index
  }
}
