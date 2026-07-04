/**
 * Generates the R4 model data for the ModelProvider from the FHIR R4
 * StructureDefinitions shipped in @medplum/definitions (verbatim HL7 content).
 *
 * Run from packages/fhirpath: node scripts/generate-r4-model.ts
 * Output is deterministic (sorted keys), so diffs stay reviewable.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { readJson } from '@medplum/definitions'
import type { GeneratedElement, GeneratedType } from '../src/r4/model-data.ts'

const GENERATED_DIR = resolve(import.meta.dirname, '../src/r4/generated')

interface ElementDefinition {
  path: string
  sliceName?: string
  max?: string
  contentReference?: string
  type?: { code: string }[]
}

interface StructureDefinition {
  id: string
  kind: 'resource' | 'complex-type' | 'primitive-type' | 'logical'
  abstract?: boolean
  baseDefinition?: string
  snapshot?: { element: ElementDefinition[] }
}

interface Bundle {
  entry: { resource: StructureDefinition }[]
}

const SYSTEM_TYPE_URL_PREFIX = 'http://hl7.org/fhirpath/System.'

function extract(bundles: Bundle[]): Record<string, GeneratedType> {
  const types: Record<string, GeneratedType> = {}
  for (const bundle of bundles) {
    for (const { resource: definition } of bundle.entry) {
      if (definition.kind === 'logical' || !definition.snapshot) {
        continue
      }
      const typeName = definition.id
      const base = definition.baseDefinition?.split('/').pop()
      const root: GeneratedType = { e: {} }
      if (base !== undefined && base !== typeName) {
        root.b = base
      }
      types[typeName] = root
      for (const element of definition.snapshot.element) {
        if (element.sliceName || !element.path.includes('.')) {
          continue
        }
        const separator = element.path.lastIndexOf('.')
        const ownerPath = element.path.slice(0, separator)
        let name = element.path.slice(separator + 1)
        const isChoice = name.endsWith('[x]')
        let owner = root
        if (ownerPath !== typeName) {
          owner = types[ownerPath] ?? { b: 'BackboneElement', e: {} }
          types[ownerPath] = owner
        }
        if (name.endsWith('[x]')) {
          name = name.slice(0, -3)
        }
        // An element whose own type is Element/BackboneElement defines an inline
        // component type named by its path; record the correct base so that, e.g.,
        // Timing.repeat (typed Element) is not mistaken for a BackboneElement.
        const componentBase = componentBaseCode(element)
        if (componentBase !== undefined) {
          const componentType = types[element.path] ?? { b: componentBase, e: {} }
          componentType.b = componentBase
          types[element.path] = componentType
        }
        const elementTypes = elementTypeNames(element)
        if (elementTypes.length === 0) {
          continue
        }
        const generated: GeneratedElement = { t: elementTypes }
        if (isChoice) {
          generated.c = 1
        }
        if (element.max === '*' || (element.max !== undefined && Number.parseInt(element.max, 10) > 1)) {
          generated.a = 1
        }
        owner.e[name] = generated
      }
    }
  }
  return sortKeys(types)
}

/** The Element/BackboneElement base of an inline component, or undefined for other elements. */
function componentBaseCode(element: ElementDefinition): 'Element' | 'BackboneElement' | undefined {
  for (const type of element.type ?? []) {
    if (type.code === 'BackboneElement' || type.code === 'Element') {
      return type.code
    }
  }
  return undefined
}

function elementTypeNames(element: ElementDefinition): string[] {
  if (element.contentReference !== undefined) {
    return [element.contentReference.replace(/^#/, '')]
  }
  const names: string[] = []
  for (const type of element.type ?? []) {
    let code = type.code
    if (code.startsWith(SYSTEM_TYPE_URL_PREFIX)) {
      code = `System.${code.slice(SYSTEM_TYPE_URL_PREFIX.length)}`
    }
    // Backbone and inline elements are identified by their path.
    if (code === 'BackboneElement' || code === 'Element') {
      code = element.path.endsWith('[x]') ? element.path.slice(0, -3) : element.path
    }
    if (!names.includes(code)) {
      names.push(code)
    }
  }
  return names
}

function sortKeys(types: Record<string, GeneratedType>): Record<string, GeneratedType> {
  const sorted: Record<string, GeneratedType> = {}
  for (const key of Object.keys(types).sort()) {
    const value = types[key] as GeneratedType
    const elements: Record<string, GeneratedElement> = {}
    for (const elementKey of Object.keys(value.e).sort()) {
      elements[elementKey] = value.e[elementKey] as GeneratedElement
    }
    sorted[key] = value.b === undefined ? { e: elements } : { b: value.b, e: elements }
  }
  return sorted
}

function emit(fileName: string, constName: string, data: Record<string, GeneratedType>, source: string): void {
  const body = JSON.stringify(data, null, 2)
  const content = `// Generated by scripts/generate-r4-model.ts from ${source} (@medplum/definitions).
// Do not edit by hand; re-run the script instead.
import type { GeneratedType } from '../model-data.ts'

export const ${constName}: Readonly<Record<string, GeneratedType>> = ${body}
`
  const path = resolve(GENERATED_DIR, fileName)
  writeFileSync(path, content)
  console.log(`wrote ${path} (${Object.keys(data).length} types)`)
}

/** FHIR primitive names to the TS types the public API surfaces after unwrap(). */
const PRIMITIVE_TS: Readonly<Record<string, string>> = {
  boolean: 'boolean',
  integer: 'number',
  positiveInt: 'number',
  unsignedInt: 'number',
  integer64: 'bigint',
  decimal: 'number',
  date: 'string',
  dateTime: 'string',
  instant: 'string',
  time: 'string',
  string: 'string',
  code: 'string',
  id: 'string',
  markdown: 'string',
  uri: 'string',
  url: 'string',
  canonical: 'string',
  oid: 'string',
  uuid: 'string',
  base64Binary: 'string',
  xhtml: 'string',
}

const SYSTEM_TS: Readonly<Record<string, string>> = {
  'System.String': 'string',
  'System.Boolean': 'boolean',
  'System.Integer': 'number',
  'System.Long': 'bigint',
  'System.Decimal': 'number',
  'System.Date': 'string',
  'System.DateTime': 'string',
  'System.Time': 'string',
}

/** `Patient.contact` → `PatientContact`; plain names stay as they are. */
function interfaceName(typeName: string): string {
  return typeName
    .split('.')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

function tsTypeOf(elementTypeName: string, all: Record<string, GeneratedType>): string {
  const primitive = PRIMITIVE_TS[elementTypeName]
  if (primitive !== undefined) {
    return primitive
  }
  const system = SYSTEM_TS[elementTypeName]
  if (system !== undefined) {
    return system
  }
  if (elementTypeName === 'Resource' || elementTypeName === 'DomainResource') {
    return 'FhirResource'
  }
  return all[elementTypeName] ? interfaceName(elementTypeName) : 'unknown'
}

/**
 * Emits the type-level side: structural interfaces for every type (so inferred
 * results are real object shapes) plus the element map and base map the
 * template-literal parser walks. Same source data as the runtime tables, so the
 * two stay in lockstep by construction.
 */
function emitTypeMaps(all: Record<string, GeneratedType>, resourceNames: string[]): void {
  const lines: string[] = [
    '// Generated by scripts/generate-r4-model.ts from the R4 StructureDefinitions (@medplum/definitions).',
    '// Do not edit by hand; re-run the script instead.',
    '',
    '/** Any resource: the dispatch shape for contained/Bundle entries. */',
    'export interface FhirResource {',
    '  resourceType: string',
    '  [key: string]: unknown',
    '}',
    '',
  ]
  const names = Object.keys(all).filter(name => PRIMITIVE_TS[name] === undefined)
  for (const name of names) {
    const definition = all[name] as GeneratedType
    const base =
      definition.b !== undefined && all[definition.b] && PRIMITIVE_TS[definition.b] === undefined
        ? interfaceName(definition.b)
        : undefined
    const heritage = base !== undefined && base !== interfaceName(name) ? ` extends ${interfaceName(base)}` : ''
    const elementCount = Object.keys(definition.e).length + (resourceNames.includes(name) ? 1 : 0)
    if (elementCount === 0 && heritage !== '') {
      lines.push(`export type ${interfaceName(name)} = ${interfaceName(base as string)}`, '')
      continue
    }
    lines.push(`export interface ${interfaceName(name)}${heritage} {`)
    if (resourceNames.includes(name)) {
      lines.push(`  resourceType: '${name}'`)
    }
    for (const [element, info] of Object.entries(definition.e)) {
      const suffix = info.a === 1 ? '[]' : ''
      if (info.c === 1) {
        for (const typeName of info.t) {
          const key = element + typeName.charAt(0).toUpperCase() + typeName.slice(1)
          lines.push(`  ${quoteKey(key)}?: ${tsTypeOf(typeName, all)}${suffix}`)
        }
      } else {
        lines.push(`  ${quoteKey(element)}?: ${info.t.map(t => tsTypeOf(t, all)).join(' | ')}${suffix}`)
      }
    }
    lines.push('}', '')
  }
  lines.push('/** Element map for type-level path inference: name -> { t: type-name(s), a: array }. */')
  lines.push('export interface R4Elements {')
  for (const name of Object.keys(all)) {
    const definition = all[name] as GeneratedType
    const entries = Object.entries(definition.e)
    if (entries.length === 0) {
      // An empty object type would match any value; a never-keyed shape keeps lookups clean.
      lines.push(`  '${name}': { _?: never }`)
      continue
    }
    lines.push(`  '${name}': {`)
    for (const [element, info] of entries) {
      const union = info.t.map(t => `'${normalizeTypeName(t, all)}'`).join(' | ')
      lines.push(`    ${quoteKey(element)}: { t: ${union}; a: ${info.a === 1 ? 'true' : 'false'} }`)
    }
    lines.push('  }')
  }
  lines.push('}', '')
  lines.push('/** Type-name to TS-type dispatch, primitives included. */')
  lines.push('export interface R4TypeOf {')
  for (const [primitive, ts] of Object.entries(PRIMITIVE_TS)) {
    lines.push(`  ${quoteKey(primitive)}: ${ts}`)
  }
  for (const [system, ts] of Object.entries(SYSTEM_TS)) {
    lines.push(`  '${system}': ${ts}`)
  }
  lines.push('  Resource: FhirResource')
  lines.push('  DomainResource: FhirResource')
  for (const name of Object.keys(all)) {
    if (PRIMITIVE_TS[name] !== undefined || name === 'Resource' || name === 'DomainResource') {
      continue
    }
    lines.push(`  '${name}': ${interfaceName(name)}`)
  }
  lines.push('}', '')
  lines.push('/** Base-type map so element lookup can walk the hierarchy. */')
  lines.push('export interface R4Bases {')
  for (const name of Object.keys(all)) {
    const base = (all[name] as GeneratedType).b
    if (base !== undefined && all[base]) {
      lines.push(`  '${name}': '${base}'`)
    }
  }
  lines.push('}', '')
  lines.push('/** Resource-name dispatch for expression roots like `Patient.name`. */')
  lines.push('export interface R4Resources {')
  for (const name of resourceNames) {
    lines.push(`  ${quoteKey(name)}: ${interfaceName(name)}`)
  }
  lines.push('}', '')
  const path = resolve(GENERATED_DIR, 'type-maps.ts')
  writeFileSync(path, lines.join('\n'))
  console.log(`wrote ${path} (${names.length} interfaces)`)
}

/**
 * Format the freshly written files with Biome so the committed output is
 * byte-identical to what the repo's lint-staged hook produces. Without this,
 * regeneration leaves a whitespace-only diff and the "one generator run, no
 * drift" guarantee is false.
 */
function formatGenerated(): void {
  execFileSync('pnpm', ['exec', 'biome', 'check', '--write', '--no-errors-on-unmatched', GENERATED_DIR], {
    stdio: 'inherit',
  })
}

/** Element-type names normalize so R4TypeOf can dispatch them directly. */
function normalizeTypeName(elementTypeName: string, all: Record<string, GeneratedType>): string {
  if (
    PRIMITIVE_TS[elementTypeName] !== undefined ||
    SYSTEM_TS[elementTypeName] !== undefined ||
    elementTypeName === 'Resource' ||
    elementTypeName === 'DomainResource' ||
    all[elementTypeName]
  ) {
    return elementTypeName
  }
  return 'Resource'
}

function quoteKey(key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : `'${key}'`
}

const typeBundle = readJson('fhir/r4/profiles-types.json') as Bundle
const resourceBundle = readJson('fhir/r4/profiles-resources.json') as Bundle

const dataTypes = extract([typeBundle])
const resources = extract([resourceBundle])
emit('types-data.ts', 'R4_DATA_TYPES', dataTypes, 'profiles-types.json')
emit('resources-data.ts', 'R4_RESOURCES', resources, 'profiles-resources.json')

const merged: Record<string, GeneratedType> = { ...dataTypes, ...resources }
const resourceNames = resourceBundle.entry
  .map(entry => entry.resource)
  .filter(definition => definition.kind === 'resource' && definition.snapshot && !definition.abstract)
  .map(definition => definition.id)
  .sort()
emitTypeMaps(merged, resourceNames)
formatGenerated()
