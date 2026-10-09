/**
 * Generates the R4 model data for the ModelProvider from the FHIR R4
 * StructureDefinitions shipped in @medplum/definitions (verbatim HL7 content).
 *
 * Run from packages/fhirpath: node scripts/generate-r4-model.ts
 * Output is deterministic (sorted keys), so diffs stay reviewable.
 */
import { resolve } from 'node:path'

import { readJson } from '@medplum/definitions'

import { encodeCompactTypes, type GeneratedElement, type GeneratedType } from '../src/r4/model-data.ts'
import { FHIR_PRIMITIVE_TO_TYPESCRIPT, FHIRPATH_SYSTEM_TO_TYPESCRIPT } from './fhir-type-maps.ts'
import { formatGeneratedTypeScript } from './format-generated.ts'
import { writeOrCheckGenerated } from './generated-file.ts'

const GENERATED_DIR = resolve(import.meta.dirname, '../src/r4/generated')
const CHECK = process.argv.includes('--check')

interface ElementDefinition {
  path: string
  sliceName?: string
  min?: number
  max?: string
  contentReference?: string
  type?: { code: string; targetProfile?: string[]; extension?: { url: string; valueString?: string }[] }[]
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
const REGEX_EXTENSION_URL = 'http://hl7.org/fhir/StructureDefinition/regex'

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

interface CodeIndex {
  codeSystems: Map<string, CodeSystemResource>
  valueSets: Map<string, ValueSetResource>
}

/**
 * Index of the ValueSet/CodeSystem resources shipped alongside the R4
 * StructureDefinitions, used to resolve enumerated `code` bindings (e.g.
 * Patient.gender) into literal string unions instead of plain `string`.
 */
function loadCodeIndex(): CodeIndex {
  const codeSystems = new Map<string, CodeSystemResource>()
  const valueSets = new Map<string, ValueSetResource>()
  // valuesets-medplum-generated.json holds the complete code systems FHIR only
  // references, such as ISO 4217 currencies, which `@medplum/fhirtypes`
  // enumerates; a generated value must assign to the Medplum type.
  for (const file of ['fhir/r4/valuesets.json', 'fhir/r4/valuesets-medplum-generated.json']) {
    const bundle = readJson(file) as TerminologyBundle
    for (const { resource } of bundle.entry) {
      if (resource.resourceType === 'CodeSystem' && resource.url !== undefined) {
        codeSystems.set(resource.url, resource)
      } else if (resource.resourceType === 'ValueSet' && resource.url !== undefined) {
        valueSets.set(resource.url, resource)
      }
    }
  }
  return { codeSystems, valueSets }
}

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
 * The codes of a value set, or undefined when it cannot be resolved to a fixed
 * enumeration: an external code system the bundled definitions do not carry
 * (MIME types, BCP 47 languages), or a filtered or composed set. There is no
 * size cap: the broad lists (currencies, all types) are a few hundred members
 * and only cost when navigated.
 */
function resolveCodes(valueSetUrl: string, index: CodeIndex): string[] | undefined {
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
  return codes.length > 0 ? codes : undefined
}

const RESOURCE_TYPES_VALUE_SET = 'http://hl7.org/fhir/ValueSet/resource-types'

/** An element's enumerated codes, and whether its binding is required. */
interface EnumeratedCodes {
  codes: string[]
  /** A required binding is a claim about every value; an extensible one admits others. */
  required: boolean
}

/**
 * The enumerated codes of an element, or undefined when it has none. Required
 * and extensible `code` bindings the definitions can list are enumerated,
 * which covers every binding `@medplum/fhirtypes` enumerates and a few more,
 * so a generated value assigns to the Medplum type. `Reference.type`, a uri
 * bound to the resource-types value set, is the union of the concrete resource
 * names, as Medplum types it. A required `code` bound to that value set, such
 * as `SearchParameter.base`, resolves like any other binding and keeps the
 * abstract `Resource` and `DomainResource` the spec's own instances use.
 */
function enumeratedCodesFor(
  element: ElementDefinition,
  elementTypes: string[],
  isChoice: boolean,
  codeIndex: CodeIndex,
  resourceNames: readonly string[]
): EnumeratedCodes | undefined {
  const valueSet = element.binding?.valueSet?.replace(/\|.*$/, '')
  if (isChoice || valueSet === undefined || elementTypes.length !== 1) {
    return undefined
  }
  if (elementTypes[0] === 'uri' && valueSet === RESOURCE_TYPES_VALUE_SET) {
    return { codes: [...resourceNames], required: false }
  }
  const strength = element.binding?.strength
  if ((strength !== 'required' && strength !== 'extensible') || elementTypes[0] !== 'code') {
    return undefined
  }
  const codes = resolveCodes(valueSet, codeIndex)
  return codes === undefined ? undefined : { codes, required: strength === 'required' }
}

/** Resolved code unions, keyed the same way as `types`: owner type name -> element name -> codes. */
type CodeUnions = Record<string, Record<string, string[]>>

/** The type-level-only facts beside the runtime tables. */
interface TypeFacts {
  /** Every enumerated binding, for the interfaces: what a value may hold under the Medplum claim. */
  codeUnions: CodeUnions
  /** Required bindings only, for `R4Elements`: what inference may claim a navigated value is. */
  inferredCodes: CodeUnions
  requiredElements: RequiredElements
}

/**
 * Elements with FHIR minimum cardinality 1, keyed like `types`: owner type
 * name -> element names. Choice elements are left out: their JSON keys carry a
 * type suffix, so no single key can be required.
 */
type RequiredElements = Record<string, Set<string>>

/**
 * Extracts the runtime type/element data plus the type-level-only facts: the
 * enumerated code unions and the required elements. Those stay out of
 * `GeneratedType` so the runtime model data (types-data.ts/resources-data.ts)
 * isn't bloated with information only the generated interfaces and the
 * type-level parser read.
 */
function extract(
  bundles: Bundle[],
  codeIndex: CodeIndex,
  resourceNames: readonly string[]
): { types: Record<string, GeneratedType> } & TypeFacts {
  const types: Record<string, GeneratedType> = {}
  const codeUnions: CodeUnions = {}
  const inferredCodes: CodeUnions = {}
  const requiredElements: RequiredElements = {}
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
        const enumerated = enumeratedCodesFor(element, elementTypes, isChoice, codeIndex, resourceNames)
        if (enumerated !== undefined) {
          ;(codeUnions[ownerPath] ??= {})[name] = enumerated.codes
          if (enumerated.required) {
            ;(inferredCodes[ownerPath] ??= {})[name] = enumerated.codes
          }
        }
        if (!isChoice && element.min !== undefined && element.min >= 1) {
          ;(requiredElements[ownerPath] ??= new Set()).add(name)
        }
      }
    }
  }
  return { types: sortKeys(types), codeUnions, inferredCodes, requiredElements }
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

/**
 * Strips elements whose entry is byte-identical to the nearest ancestor's, so
 * the tables carry each inherited element once. Runtime and script consumers
 * walk the base chain (src/r4/index.ts findElement, listElements), which makes
 * the flattened copies redundant — about a third of all entries.
 */
function dropInheritedDuplicates(
  table: Record<string, GeneratedType>,
  merged: Record<string, GeneratedType>
): Record<string, GeneratedType> {
  const slim: Record<string, GeneratedType> = {}
  for (const [name, type] of Object.entries(table)) {
    const elements: Record<string, GeneratedElement> = {}
    for (const [element, info] of Object.entries(type.e)) {
      const inherited = nearestInheritedElement(merged, name, element)
      if (inherited === undefined || JSON.stringify(inherited) !== JSON.stringify(info)) {
        elements[element] = info
      }
    }
    slim[name] = type.b === undefined ? { e: elements } : { b: type.b, e: elements }
  }
  return slim
}

function nearestInheritedElement(
  merged: Record<string, GeneratedType>,
  typeName: string,
  element: string
): GeneratedElement | undefined {
  let current = merged[typeName]?.b
  const visited = new Set<string>()
  while (current !== undefined && !visited.has(current)) {
    visited.add(current)
    const definition = merged[current]
    if (definition === undefined) {
      return undefined
    }
    const found = definition.e[element]
    if (found !== undefined) {
      return found
    }
    current = definition.b
  }
  return undefined
}

async function emit(
  fileName: string,
  constName: string,
  data: Record<string, GeneratedType>,
  source: string
): Promise<void> {
  const content = `// Generated by scripts/generate-r4-model.ts from ${source} (@medplum/definitions).
// Do not edit by hand; re-run the script instead.

/**
 * Compact-encoded model table, one line per type; the format and decoder live
 * in src/r4/model-data.ts. Elements identical to the nearest ancestor's entry
 * are omitted — lookups walk the base chain.
 */
export const ${constName}: string = \`${encodeCompactTypes(data)}\`
`
  const path = resolve(GENERATED_DIR, fileName)
  writeGenerated(path, await formatGeneratedTypeScript(content), `${Object.keys(data).length} types`)
}

/**
 * Patterns that backtrack exponentially in a JS RegExp, with an equivalent that
 * does not. FHIR's base64Binary pattern allows whitespace on both sides of each
 * 4-character group, so a run of spaces before an invalid character splits many
 * ways; whitespace between groups belongs to one side, which keeps the strings
 * it matches and leaves one way to match them.
 */
const LINEAR_EQUIVALENTS: Readonly<Record<string, { source: string; linear: string }>> = {
  base64Binary: { source: '(\\s*([0-9a-zA-Z\\+/=]){4}\\s*)+', linear: '\\s*([0-9a-zA-Z\\+/=]{4}\\s*)+' },
}

/** Each primitive type's value pattern: the `regex` extension on the type of `<type>.value`. */
function primitivePatterns(bundle: Bundle): [string, string][] {
  const patterns: [string, string][] = []
  for (const { resource: definition } of bundle.entry) {
    if (definition.kind !== 'primitive-type' || !definition.snapshot) {
      continue
    }
    const value = definition.snapshot.element.find(element => element.path === `${definition.id}.value`)
    const pattern = value?.type?.[0]?.extension?.find(extension => extension.url === REGEX_EXTENSION_URL)?.valueString
    if (pattern === undefined) {
      continue
    }
    const equivalent = LINEAR_EQUIVALENTS[definition.id]
    if (equivalent !== undefined && equivalent.source !== pattern) {
      throw new Error(`The ${definition.id} pattern changed; review its linear equivalent: ${pattern}`)
    }
    patterns.push([definition.id, equivalent?.linear ?? pattern])
  }
  return patterns.sort(([a], [b]) => (a < b ? -1 : 1))
}

async function emitPrimitivePatterns(patterns: [string, string][]): Promise<void> {
  const entries = patterns.map(([type, pattern]) => `  ${quoteKey(type)}: ${JSON.stringify(pattern)},`)
  const content = `// Generated by scripts/generate-r4-model.ts from profiles-types.json (@medplum/definitions).
// Do not edit by hand; re-run the script instead.

/**
 * The pattern each R4 primitive type's value matches whole: the \`regex\` extension on
 * \`<type>.value\`, with base64Binary's rewritten to an equivalent a JS RegExp matches in
 * linear time (LINEAR_EQUIVALENTS in the script).
 */
export const R4_PRIMITIVE_PATTERNS: Readonly<Record<string, string>> = {
${entries.join('\n')}
}
`
  const path = resolve(GENERATED_DIR, 'primitive-patterns.ts')
  writeGenerated(path, await formatGeneratedTypeScript(content), `${patterns.length} patterns`)
}

/** `Patient.contact` → `PatientContact`; plain names stay as they are. */
function interfaceName(typeName: string): string {
  return typeName
    .split('.')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

function tsTypeOf(elementTypeName: string, all: Record<string, GeneratedType>): string {
  const primitive = FHIR_PRIMITIVE_TO_TYPESCRIPT[elementTypeName]
  if (primitive !== undefined) {
    return primitive
  }
  const system = FHIRPATH_SYSTEM_TO_TYPESCRIPT[elementTypeName]
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
 * two stay in lockstep by construction. Elements with minimum cardinality 1 are
 * required in the interfaces (see docs/adr/0003); inputs stay lenient through
 * `FhirpathInput`.
 */
async function emitTypeMaps(
  all: Record<string, GeneratedType>,
  resourceNames: string[],
  { codeUnions, inferredCodes, requiredElements }: TypeFacts
): Promise<void> {
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
    '/** Plain JavaScript shape returned for a System.Quantity value. */',
    'export interface SystemQuantity {',
    '  value: number',
    '  unit: string',
    '}',
    '',
  ]
  const names = Object.keys(all).filter(name => FHIR_PRIMITIVE_TO_TYPESCRIPT[name] === undefined)
  for (const name of names) {
    const definition = all[name] as GeneratedType
    const base =
      definition.b !== undefined && all[definition.b] && FHIR_PRIMITIVE_TO_TYPESCRIPT[definition.b] === undefined
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
      const optional = requiredElements[name]?.has(element) === true ? '' : '?'
      if (info.c === 1) {
        for (const typeName of info.t) {
          const key = element + typeName.charAt(0).toUpperCase() + typeName.slice(1)
          lines.push(`  ${quoteKey(key)}?: ${tsTypeOf(typeName, all)}${suffix}`)
        }
      } else {
        // An enumerated binding's codes replace the declared type; JSON.stringify
        // escapes each code, and Prettier normalizes the quotes in formatGenerated().
        const codes = codeUnions[name]?.[element]
        const members = codes?.map(code => JSON.stringify(code)) ?? info.t.map(t => tsTypeOf(t, all))
        const union = members.join(' | ')
        // Parenthesize multi-member unions before appending `[]`, or the array
        // suffix binds to the last union member instead of the whole union.
        const type = suffix !== '' && members.length > 1 ? `(${union})` : union
        lines.push(`  ${quoteKey(element)}${optional}: ${type}${suffix}`)
      }
    }
    lines.push('}', '')
  }
  lines.push(
    '/**',
    ' * Element map for type-level path inference: name -> { t: type-name(s), a: array,',
    ' * codes?: the codes of a required binding }. `codes` is the union the interface',
    ' * carries, so a navigated `code` infers it; an extensible binding admits other',
    ' * codes, so it has none here and infers string.',
    ' */'
  )
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
      const codes = inferredCodes[name]?.[element]
      const literals = codes === undefined ? '' : `; codes: ${codes.map(code => JSON.stringify(code)).join(' | ')}`
      lines.push(`    ${quoteKey(element)}: { t: ${union}; a: ${info.a === 1 ? 'true' : 'false'}${literals} }`)
    }
    lines.push('  }')
  }
  lines.push('}', '')
  lines.push('/** Sparse Reference target map; `unknown` marks an unconstrained Reference element. */')
  lines.push('export interface R4ReferenceTargets {')
  for (const name of Object.keys(all)) {
    const references = Object.entries((all[name] as GeneratedType).e).filter(([, info]) => info.t.includes('Reference'))
    if (references.length === 0) continue
    lines.push(`  '${name}': {`)
    for (const [element, info] of references) {
      const targets = info.r?.map(target => `'${normalizeTypeName(target, all)}'`).join(' | ') ?? "'unknown'"
      lines.push(`    ${quoteKey(element)}: ${targets}`)
    }
    lines.push('  }')
  }
  lines.push('}', '')
  lines.push('/** Type-name to TS-type dispatch, primitives included. */')
  lines.push('export interface R4TypeOf {')
  for (const [primitive, ts] of Object.entries(FHIR_PRIMITIVE_TO_TYPESCRIPT)) {
    lines.push(`  ${quoteKey(primitive)}: ${ts}`)
  }
  for (const [system, ts] of Object.entries(FHIRPATH_SYSTEM_TO_TYPESCRIPT)) {
    lines.push(`  '${system}': ${ts}`)
  }
  lines.push('  Resource: FhirResource')
  lines.push('  DomainResource: FhirResource')
  for (const name of Object.keys(all)) {
    if (FHIR_PRIMITIVE_TO_TYPESCRIPT[name] !== undefined || name === 'Resource' || name === 'DomainResource') {
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
  writeGenerated(path, await formatGeneratedTypeScript(lines.join('\n')), `${names.length} interfaces`)
}

function writeGenerated(path: string, content: string, summary: string): void {
  writeOrCheckGenerated(path, content, { check: CHECK, regenerate: 'pnpm generate:r4', summary })
}

/** Element-type names normalize so R4TypeOf can dispatch them directly. */
function normalizeTypeName(elementTypeName: string, all: Record<string, GeneratedType>): string {
  if (
    FHIR_PRIMITIVE_TO_TYPESCRIPT[elementTypeName] !== undefined ||
    FHIRPATH_SYSTEM_TO_TYPESCRIPT[elementTypeName] !== undefined ||
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
const codeIndex = loadCodeIndex()

const resourceNames = resourceBundle.entry
  .map(entry => entry.resource)
  .filter(definition => definition.kind === 'resource' && definition.snapshot && !definition.abstract)
  .map(definition => definition.id)
  .sort()
const dataTypes = extract([typeBundle], codeIndex, resourceNames)
const resources = extract([resourceBundle], codeIndex, resourceNames)
// The type-level maps (emitTypeMaps) keep the flattened `merged`; only the
// runtime tables are slimmed, since only they pay a download and decode cost.
const merged: Record<string, GeneratedType> = { ...dataTypes.types, ...resources.types }
await emit(
  'types-data.ts',
  'R4_DATA_TYPES_COMPACT',
  dropInheritedDuplicates(dataTypes.types, merged),
  'profiles-types.json'
)
await emit(
  'resources-data.ts',
  'R4_RESOURCES_COMPACT',
  dropInheritedDuplicates(resources.types, merged),
  'profiles-resources.json'
)
await emitPrimitivePatterns(primitivePatterns(typeBundle))
await emitTypeMaps(merged, resourceNames, {
  codeUnions: { ...dataTypes.codeUnions, ...resources.codeUnions },
  inferredCodes: { ...dataTypes.inferredCodes, ...resources.inferredCodes },
  requiredElements: { ...dataTypes.requiredElements, ...resources.requiredElements },
})
