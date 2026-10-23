import { FhirPathRuntimeError } from '../errors.ts'
import { Decimal } from '../values/decimal.ts'

/**
 * The SDC weight rules shared by `weight()` and the terminology providers
 * that read CodeSystem resources: which extensions carry a weight, how a
 * CodeSystem concept carries one, and which listing applies to a Coding's
 * version. This module has no side effects, so a provider entry point can
 * import it without registering functions.
 */

/** The weight extensions in FHIR's and SDC's spellings. */
export const WEIGHT_URLS = new Set<unknown>([
  'http://hl7.org/fhir/StructureDefinition/itemWeight',
  'http://hl7.org/fhir/StructureDefinition/ordinalValue',
])

/** The CodeSystem property that carries a concept's weight. */
const WEIGHT_PROPERTY_URI = 'http://hl7.org/fhir/concept-properties#itemWeight'

/** The concept a value names in a CodeSystem, by system, code, and the version the value declares. */
export interface ConceptKey {
  system: string
  code: string
  version: unknown
}

/** One listing of a concept: the code system version it selects, and its weight. */
export interface VersionedWeight {
  version: unknown
  weight: Decimal | undefined
}

/**
 * The listings that apply to a Coding's version. A listing with that version
 * is the concept the Coding names. A listing without a version, or with the
 * `*` wildcard, selects every version, and stands in when none names the
 * Coding's version. A listing with another version is another concept. A
 * Coding without a version may be any listing.
 */
function applicable<T extends { version: unknown }>(listings: T[], version: unknown): T[] {
  if (version === undefined) return listings
  const named = listings.filter(listing => listing.version === version)
  return named.length > 0 ? named : listings.filter(listing => listing.version === undefined || listing.version === '*')
}

/** The one weight the applicable listings agree on; a conflict fails the call rather than choosing a score. */
export function versionedWeight(listings: VersionedWeight[], version: unknown, where: string): Decimal | undefined {
  const weights: Decimal[] = []
  for (const { weight } of applicable(listings, version)) {
    if (weight !== undefined && !weights.some(known => known.equals(weight))) weights.push(weight)
  }
  if (weights.length > 1) {
    const reason =
      version === undefined ? 'across code system versions; the Coding names none' : `for version ${String(version)}`
    throw new FhirPathRuntimeError(`weight() finds different weights for ${where} ${reason}`)
  }
  return weights[0]
}

type Json = Record<string, unknown>

const isJson = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const list = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isJson) : [])

/** Every concept of a CodeSystem, nested ones included. */
function concepts(codeSystem: Json): Json[] {
  const found: Json[] = []
  const pending = list(codeSystem['concept'])
  while (pending.length > 0) {
    const concept = pending.shift() as Json
    found.push(concept)
    pending.push(...list(concept['concept']))
  }
  return found
}

/** A weight read from JSON: a number, or the call fails so a malformed score never lowers a total. */
export function numericWeight(value: unknown, what: string): Decimal {
  const decimal = typeof value === 'number' ? Decimal.fromNumber(value) : undefined
  if (decimal === undefined) throw new FhirPathRuntimeError(`weight() requires a numeric ${what}`)
  return decimal
}

/** A concept's weight: a weight extension, or the property its CodeSystem declares for weights. */
function conceptWeight(codeSystem: Json, concept: Json): Decimal | undefined {
  const extension = list(concept['extension']).find(item => WEIGHT_URLS.has(item['url']))
  if (extension !== undefined) return numericWeight(extension['valueDecimal'], 'valueDecimal on the weight extension')
  const weightCodes = new Set(
    list(codeSystem['property'])
      .filter(property => property['uri'] === WEIGHT_PROPERTY_URI || property['code'] === 'itemWeight')
      .map(property => property['code'])
  )
  const property = list(concept['property']).find(item => weightCodes.has(item['code']))
  if (property === undefined) return undefined
  const valueKey = Object.keys(property).find(key => key.startsWith('value'))
  return numericWeight(valueKey === undefined ? undefined : property[valueKey], 'CodeSystem itemWeight')
}

/**
 * A concept's weight from CodeSystem resources (JSON), by the version rules
 * of `versionedWeight`. The result is undefined when no applicable CodeSystem
 * lists the code and none of them lists all its codes, so the caller asks
 * elsewhere; `{ weight: undefined }` is a concept found without a weight. A
 * complete CodeSystem without the code fails the call.
 */
export function codeSystemWeight(
  codeSystems: unknown[],
  { system, code, version }: ConceptKey
): { weight: Decimal | undefined } | undefined {
  const candidates = codeSystems
    .filter(isJson)
    .filter(codeSystem => codeSystem['resourceType'] === 'CodeSystem' && codeSystem['url'] === system)
    .map(codeSystem => ({ version: codeSystem['version'], codeSystem }))
  const selected = applicable(candidates, version)
  const listings: VersionedWeight[] = []
  for (const { version: listed, codeSystem } of selected) {
    const concept = concepts(codeSystem).find(item => item['code'] === code)
    if (concept !== undefined) listings.push({ version: listed, weight: conceptWeight(codeSystem, concept) })
  }
  if (listings.length > 0)
    return { weight: versionedWeight(listings, version, `code '${code}' in CodeSystem ${system}`) }
  if (selected.some(({ codeSystem }) => codeSystem['content'] === 'complete')) {
    throw new FhirPathRuntimeError(`weight() cannot find code '${code}' in CodeSystem ${system}`)
  }
  return undefined
}
