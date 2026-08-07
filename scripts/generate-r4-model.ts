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
  type?: { code: string; targetProfile?: string[] }[]
  binding?: { strength?: string; valueSet?: string }
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

/** A CodeSystem concept, which may nest narrower concepts to arbitrary depth. */
interface CodeSystemConcept {
  code: string
  concept?: CodeSystemConcept[]
}

interface CodeSystemResource {
  resourceType: 'CodeSystem'
  url?: string
  content?: string
  concept?: CodeSystemConcept[]
}

interface ValueSetInclude {
  system?: string
  concept?: { code: string }[]
  filter?: unknown[]
  valueSet?: string[]
}

interface ValueSetResource {
  resourceType: 'ValueSet'
  url?: string
  compose?: { include?: ValueSetInclude[]; exclude?: ValueSetInclude[] }
}

interface TerminologyBundle {
  entry: { resource: CodeSystemResource | ValueSetResource }[]
}

interface RequiredCodeIndex {
  codeSystems: Map<string, CodeSystemResource>
  valueSets: Map<string, ValueSetResource>
}

/**
 * Index of the ValueSet/CodeSystem resources shipped alongside the R4
 * StructureDefinitions, used to resolve `required`-strength `code` bindings
 * (e.g. Patient.gender) into literal string unions instead of plain `string`.
 */
function loadRequiredCodeIndex(): RequiredCodeIndex {
  const bundle = readJson('fhir/r4/valuesets.json') as TerminologyBundle
  const codeSystems = new Map<string, CodeSystemResource>()
  const valueSets = new Map<string, ValueSetResource>()
  for (const { resource } of bundle.entry) {
    if (resource.resourceType === 'CodeSystem' && resource.url !== undefined) {
      codeSystems.set(resource.url, resource)
    } else if (resource.resourceType === 'ValueSet' && resource.url !== undefined) {
      valueSets.set(resource.url, resource)
    }
  }
  return { codeSystems, valueSets }
}

/**
 * Maximum generated literal-union size. Domain code sets end at 31 entries;
 * broad metadata lists begin at 148 and remain plain strings.
 */
const MAX_UNION_SIZE = 40

/**
 * Every code in a CodeSystem concept tree. R4 nests narrower codes under
 * broader ones — `old` has the child `maiden`, `accepted` has `active`,
 * `on-hold` and `completed` — and all of them are equally valid values for a
 * binding to the enclosing value set, so the whole tree has to be walked.
 */
function conceptCodes(concepts: CodeSystemConcept[]): string[] {
  return concepts.flatMap(concept => [concept.code, ...conceptCodes(concept.concept ?? [])])
}

/**
 * The closed set of codes for a required binding, or undefined when the value
 * set can't be resolved to a fixed enumeration (external/unbounded code
 * systems like MIME types or ISO 4217 currencies, filtered/composed sets, or
 * an enumeration too large to be worth inlining; see MAX_UNION_SIZE).
 */
function resolveRequiredCodes(valueSetUrl: string, index: RequiredCodeIndex): string[] | undefined {
  const valueSet = index.valueSets.get(valueSetUrl.replace(/\|.*$/, ''))
  if (!valueSet?.compose || valueSet.compose.exclude) {
    return undefined
  }
  const codes: string[] = []
  for (const include of valueSet.compose.include ?? []) {
    if (include.filter || include.valueSet) {
      return undefined
    }
    if (include.concept) {
      codes.push(...include.concept.map(concept => concept.code))
    } else if (include.system) {
      const codeSystem = index.codeSystems.get(include.system)
      if (codeSystem?.content !== 'complete' || !codeSystem.concept) {
        return undefined
      }
      codes.push(...conceptCodes(codeSystem.concept))
    } else {
      return undefined
    }
  }
  return codes.length > 0 && codes.length <= MAX_UNION_SIZE ? codes : undefined
}

/** The literal union codes for an element, or undefined if it isn't eligible (see resolveRequiredCodes). */
function requiredCodeUnionFor(
  element: ElementDefinition,
  elementTypes: string[],
  isChoice: boolean,
  codeIndex: RequiredCodeIndex
): string[] | undefined {
  if (isChoice || element.binding?.strength !== 'required' || element.binding.valueSet === undefined) {
    return undefined
  }
  if (elementTypes.length !== 1 || elementTypes[0] !== 'code') {
    return undefined
  }
  return resolveRequiredCodes(element.binding.valueSet, codeIndex)
}

/** Resolved code unions, keyed the same way as `types`: owner type name -> element name -> codes. */
type CodeUnions = Record<string, Record<string, string[]>>

/**
 * Extracts the runtime type/element data plus the literal code unions resolved
 * for required bindings. The unions stay out of `GeneratedType` so the runtime
 * model data (types-data.ts/resources-data.ts) isn't bloated with
 * type-level-only information.
 */
function extract(
  bundles: Bundle[],
  codeIndex: RequiredCodeIndex
): { types: Record<string, GeneratedType>; codeUnions: CodeUnions } {
  const types: Record<string, GeneratedType> = {}
  const codeUnions: CodeUnions = {}
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
        const targets = referenceTargets(element)
        if (targets !== undefined) {
          generated.r = targets
        }
        owner.e[name] = generated
        const codes = requiredCodeUnionFor(element, elementTypes, isChoice, codeIndex)
        if (codes) {
          const ownerUnions = (codeUnions[ownerPath] ??= {})
          ownerUnions[name] = codes
        }
      }
    }
  }
  return { types: sortKeys(types), codeUnions }
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

/**
 * Resource names a Reference-typed element may point to, from
 * ElementDefinition.type.targetProfile — undefined when the element has no
 * Reference type or the reference is unconstrained (no profiles, or an
 * explicit Resource target).
 */
function referenceTargets(element: ElementDefinition): string[] | undefined {
  const targets: string[] = []
  for (const type of element.type ?? []) {
    if (type.code !== 'Reference') {
      continue
    }
    if (type.targetProfile === undefined || type.targetProfile.length === 0) {
      return undefined
    }
    for (const profile of type.targetProfile) {
      const name = profile.split('/').pop()
      if (name === undefined || name === 'Resource') {
        return undefined
      }
      if (!targets.includes(name)) {
        targets.push(name)
      }
    }
  }
  return targets.length > 0 ? targets : undefined
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

/** Maps FHIR primitive names to the TypeScript values returned after `unwrap()`. */
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
function emitTypeMaps(all: Record<string, GeneratedType>, resourceNames: string[], codeUnions: CodeUnions): void {
  const lines: string[] = [
    '// Generated by scripts/generate-r4-model.ts from the R4 StructureDefinitions (@medplum/definitions).',
    '// Do not edit by hand; re-run the script instead.',
    '',
    '/**',
    ' * Any resource: the dispatch shape for contained/Bundle entries. Deliberately',
    ' * has no `[key: string]: unknown` index signature — TypeScript only infers',
    ' * implicit index signatures for type aliases, so requiring one here would',
    ' * reject every interface-declared resource (our own generated ones included,',
    " * and @medplum/fhirtypes') from a `contained` or `Bundle.entry.resource` slot.",
    ' */',
    'export interface FhirResource {',
    '  resourceType: string',
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
        // A required binding's closed code set replaces the declared type; JSON.stringify
        // escapes each code, and Prettier normalizes the quotes in formatGenerated().
        const codes = codeUnions[name]?.[element]
        const members = codes?.map(code => JSON.stringify(code)) ?? info.t.map(t => tsTypeOf(t, all))
        const union = members.join(' | ')
        // Parenthesize multi-member unions before appending `[]`, or the array
        // suffix binds to the last union member instead of the whole union.
        const type = suffix !== '' && members.length > 1 ? `(${union})` : union
        lines.push(`  ${quoteKey(element)}?: ${type}${suffix}`)
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
 * Format the freshly written files with Prettier so the committed output is
 * byte-identical to what the repo's lint-staged hook produces. Without this,
 * regeneration leaves a whitespace-only diff and the "one generator run, no
 * drift" guarantee is false. The generated dir is Prettier-ignored for the
 * normal `format` run, so it is passed explicitly with the ignore file disabled.
 */
function formatGenerated(): void {
  execFileSync('pnpm', ['exec', 'prettier', '--write', '--ignore-path', '', GENERATED_DIR], {
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
const codeIndex = loadRequiredCodeIndex()

const dataTypes = extract([typeBundle], codeIndex)
const resources = extract([resourceBundle], codeIndex)
emit('types-data.ts', 'R4_DATA_TYPES', dataTypes.types, 'profiles-types.json')
emit('resources-data.ts', 'R4_RESOURCES', resources.types, 'profiles-resources.json')

const merged: Record<string, GeneratedType> = { ...dataTypes.types, ...resources.types }
const codeUnions: CodeUnions = { ...dataTypes.codeUnions, ...resources.codeUnions }
const resourceNames = resourceBundle.entry
  .map(entry => entry.resource)
  .filter(definition => definition.kind === 'resource' && definition.snapshot && !definition.abstract)
  .map(definition => definition.id)
  .sort()
emitTypeMaps(merged, resourceNames, codeUnions)
formatGenerated()
