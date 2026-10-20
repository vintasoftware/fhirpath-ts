import { forEachCollecting } from '../engine/async.ts'
import { type EvaluationContext, lookupEnvironmentVariable } from '../engine/context.ts'
import { pairEquals, pairEquivalent } from '../engine/operators/equality.ts'
import { FhirPathRuntimeError } from '../errors.ts'
import { elementOrigin, owningResource, rootResourceOf } from '../fhir/element-origin.ts'
import { extensionArraysOf } from '../fhir/extensions.ts'
import { readModelProperty } from '../fhir/model-navigation.ts'
import type { ModelProvider } from '../model/provider.ts'
import { Decimal } from '../values/decimal.ts'
import { SYSTEM_DECIMAL, toTypedValue, type TypedValue } from '../values/typed-value.ts'
import { registerFunction } from './registry.ts'
import { callProvider, isObject, type ParameterEntry, parameterList, parameterValueX } from './terminology.ts'

const WEIGHT_URLS = new Set<unknown>([
  'http://hl7.org/fhir/StructureDefinition/itemWeight',
  'http://hl7.org/fhir/StructureDefinition/ordinalValue',
])

const ANSWER_TYPE = 'FHIR.QuestionnaireResponse.item.answer'

/** The CodeSystem property that carries a concept's weight. */
const WEIGHT_PROPERTY_URI = 'http://hl7.org/fhir/concept-properties#itemWeight'

/** SDC local scores; unresolved terminology must not silently lower a total. */
registerFunction('weight', {
  minArity: 0,
  maxArity: 0,
  evaluate: (context, input) => {
    const model = context.model
    // Without a model, answers and Codings are untyped, so their option and
    // terminology lookups would be skipped instead of reported.
    if (model === undefined) {
      throw new FhirPathRuntimeError('weight() needs a model to find answers, answer options, and Codings')
    }
    const weights: TypedValue[] = []
    // Each item's lookup is independent, so they are requested together.
    forEachCollecting(input, item => {
      const score = weightOf(context, model, item)
      if (score !== undefined) weights.push({ type: SYSTEM_DECIMAL, value: score })
    })
    return weights
  },
})

function embeddedWeight(item: TypedValue | undefined): Decimal | undefined {
  if (item === undefined) return undefined
  for (const extension of extensionArraysOf(item).flat()) {
    const fields = extension as { url?: unknown; valueDecimal?: unknown } | null
    if (fields === null || !WEIGHT_URLS.has(fields.url)) continue
    const score = typeof fields.valueDecimal === 'number' ? Decimal.fromNumber(fields.valueDecimal) : undefined
    if (score === undefined)
      throw new FhirPathRuntimeError('weight() requires a numeric valueDecimal on the weight extension')
    return score
  }
  return undefined
}

function weightOf(context: EvaluationContext, model: ModelProvider, item: TypedValue): Decimal | undefined {
  const origin = elementOrigin(item)
  const answer =
    item.type === ANSWER_TYPE
      ? item
      : origin?.parent.type === ANSWER_TYPE && origin.name === 'value'
        ? origin.parent
        : undefined
  const value = answer === item ? children(model, item, 'value')[0] : item
  // An answer-level weight overrides its value's, whether the call starts at the answer or its value.
  const embedded = embeddedWeight(answer) ?? embeddedWeight(value)
  if (embedded !== undefined) return embedded
  if (value === undefined) return undefined
  if (answer !== undefined) {
    const questionnaire = lookupEnvironmentVariable(context, 'questionnaire')
    if (questionnaire?.length !== 1 || questionnaire[0]?.type !== 'FHIR.Questionnaire') {
      throw new FhirPathRuntimeError('weight() needs %questionnaire to resolve answer options')
    }
    const question = questionFor(model, questionnaire[0], answer)
    for (const option of children(model, question, 'answerOption')) {
      const candidate = children(model, option, 'value')[0]
      if (candidate === undefined) continue
      const matches =
        value.type === 'FHIR.Coding' && candidate.type === 'FHIR.Coding'
          ? pairEquivalent(value, candidate)
          : pairEquals(value, candidate) === true
      if (matches) {
        const score = embeddedWeight(option) ?? embeddedWeight(candidate)
        if (score !== undefined) return score
      }
    }
    const valueSet = children(model, question, 'answerValueSet')[0]?.value
    if (typeof valueSet === 'string') {
      const score = valueSetWeight(context, model, questionnaire[0], valueSet, value)
      if (score !== undefined) return score
    }
  }
  // A code's CodeSystem comes from its binding and a Coding's from its system.
  // A Coding without a system names no CodeSystem, so it has no weight.
  if (value.type === 'FHIR.code') {
    throw new FhirPathRuntimeError('weight() cannot resolve the CodeSystem binding of a code')
  }
  const system = value.type === 'FHIR.Coding' ? children(model, value, 'system')[0]?.value : undefined
  if (typeof system === 'string') {
    const code = children(model, value, 'code')[0]?.value
    if (typeof code !== 'string') {
      throw new FhirPathRuntimeError('weight() needs a Coding with a code for CodeSystem lookup')
    }
    const version = children(model, value, 'version')[0]?.value
    const questionnaire = answer === undefined ? undefined : lookupEnvironmentVariable(context, 'questionnaire')?.[0]
    const contained = containedCodeSystemWeight(model, [ownerOf(value), questionnaire], system, code, version)
    if (contained !== undefined) return contained.weight
    const response = parameterList(callProvider(context, 'weight()', 'lookup', [value.value, 'property=itemWeight']))
    if (response === undefined) throw new FhirPathRuntimeError('weight() cannot resolve the CodeSystem')
    const weight = lookupProperty(response, 'itemWeight')
    return weight === undefined ? undefined : numericWeight(weight)
  }
  return undefined
}

/**
 * The weight a bound value set gives a Coding answer: from a ValueSet contained
 * in the Questionnaire (`#id`, or a matching url and version), or else from the
 * provider's expansion. The concept carries it as a weight extension on its
 * expansion entry or, when that has none, on its `compose.include.concept`. A
 * concept without one, or a code the value set does not list, leaves the lookup
 * to the CodeSystem; a value set that cannot be resolved fails the call.
 */
function valueSetWeight(
  context: EvaluationContext,
  model: ModelProvider,
  questionnaire: TypedValue,
  canonical: string,
  value: TypedValue
): Decimal | undefined {
  const system = children(model, value, 'system')[0]?.value
  const code = children(model, value, 'code')[0]?.value
  if (value.type !== 'FHIR.Coding' || typeof system !== 'string' || typeof code !== 'string') return undefined
  const valueSet = containedValueSet(model, questionnaire, canonical) ?? expandedValueSet(context, canonical)
  const entry = nested(model, children(model, valueSet, 'expansion'), 'contains').find(item =>
    matches(model, item, system, code)
  )
  const concept = children(model, valueSet, 'compose')
    .flatMap(compose => children(model, compose, 'include'))
    .filter(include => children(model, include, 'system')[0]?.value === system)
    .flatMap(include => children(model, include, 'concept'))
    .find(item => children(model, item, 'code')[0]?.value === code)
  return embeddedWeight(entry) ?? embeddedWeight(concept)
}

function containedValueSet(model: ModelProvider, questionnaire: TypedValue, canonical: string): TypedValue | undefined {
  const contained = children(model, questionnaire, 'contained').filter(resource => resource.type === 'FHIR.ValueSet')
  if (canonical.startsWith('#')) {
    const found = contained.find(resource => children(model, resource, 'id')[0]?.value === canonical.slice(1))
    if (found === undefined) throw new FhirPathRuntimeError(`weight() cannot find the contained ValueSet ${canonical}`)
    return found
  }
  const [url, version] = canonical.split('|')
  return contained.find(
    resource =>
      children(model, resource, 'url')[0]?.value === url &&
      (version === undefined || children(model, resource, 'version')[0]?.value === version)
  )
}

function expandedValueSet(context: EvaluationContext, canonical: string): TypedValue {
  const expansion = callProvider(context, 'weight()', 'expand', [canonical])
  const valueSet = toTypedValue(expansion)
  if (valueSet.type !== 'FHIR.ValueSet')
    throw new FhirPathRuntimeError(`weight() cannot resolve the ValueSet ${canonical}`)
  return valueSet
}

/**
 * A Coding's weight from a CodeSystem contained in one of `scopes` (the
 * resource holding the value, and the Questionnaire for an answer). The result
 * is undefined when no contained CodeSystem answers, so the provider is asked:
 * none matches the system and version, or one that does not list all its codes
 * lacks this one. A complete CodeSystem without the code fails the call.
 */
function containedCodeSystemWeight(
  model: ModelProvider,
  scopes: (TypedValue | undefined)[],
  system: string,
  code: string,
  version: unknown
): { weight: Decimal | undefined } | undefined {
  for (const scope of scopes) {
    if (scope === undefined) continue
    for (const codeSystem of children(model, scope, 'contained')) {
      if (codeSystem.type !== 'FHIR.CodeSystem' || children(model, codeSystem, 'url')[0]?.value !== system) continue
      if (version !== undefined && children(model, codeSystem, 'version')[0]?.value !== version) continue
      const concept = nested(model, [codeSystem], 'concept').find(
        item => children(model, item, 'code')[0]?.value === code
      )
      if (concept !== undefined) return { weight: conceptWeight(model, codeSystem, concept) }
      if (children(model, codeSystem, 'content')[0]?.value === 'complete') {
        throw new FhirPathRuntimeError(`weight() cannot find code '${code}' in CodeSystem ${system}`)
      }
    }
  }
  return undefined
}

/** A CodeSystem concept's weight: a weight extension, or the property the CodeSystem declares for it. */
function conceptWeight(model: ModelProvider, codeSystem: TypedValue, concept: TypedValue): Decimal | undefined {
  const embedded = embeddedWeight(concept)
  if (embedded !== undefined) return embedded
  const weightCodes = new Set(
    children(model, codeSystem, 'property')
      .filter(
        property =>
          children(model, property, 'uri')[0]?.value === WEIGHT_PROPERTY_URI ||
          children(model, property, 'code')[0]?.value === 'itemWeight'
      )
      .map(property => children(model, property, 'code')[0]?.value)
  )
  for (const property of children(model, concept, 'property')) {
    if (!weightCodes.has(children(model, property, 'code')[0]?.value)) continue
    return numericWeight(children(model, property, 'value')[0]?.value)
  }
  return undefined
}

/** A CodeSystem weight property's value: a Decimal or integer when contained, a JSON number from $lookup. */
function numericWeight(value: unknown): Decimal {
  const decimal = value instanceof Decimal ? value : typeof value === 'number' ? Decimal.fromNumber(value) : undefined
  if (decimal === undefined) throw new FhirPathRuntimeError('weight() requires a numeric CodeSystem itemWeight')
  return decimal
}

/** Every `name` child at any depth below `roots`: nested concepts or expansion entries. */
function nested(model: ModelProvider, roots: TypedValue[], name: string): TypedValue[] {
  const found: TypedValue[] = []
  const pending = roots.flatMap(root => children(model, root, name))
  while (pending.length > 0) {
    const item = pending.shift() as TypedValue
    found.push(item)
    pending.push(...children(model, item, name))
  }
  return found
}

function matches(model: ModelProvider, item: TypedValue, system: string, code: string): boolean {
  return children(model, item, 'system')[0]?.value === system && children(model, item, 'code')[0]?.value === code
}

/** The resource whose contained resources a value can use: its own, or its container's when it is contained. */
function ownerOf(value: TypedValue): TypedValue | undefined {
  const resource = owningResource(value)
  return resource === undefined ? undefined : rootResourceOf(resource)
}

/** A $lookup property part value, e.g. the itemWeight ordinal. */
function lookupProperty(parameters: ParameterEntry[], code: string): unknown {
  for (const parameter of parameters) {
    if (parameter.name !== 'property' || !Array.isArray(parameter.part)) {
      continue
    }
    const parts = parameter.part.filter(isObject) as ParameterEntry[]
    const codePart = parts.find(part => part.name === 'code')
    const valuePart = parts.find(part => part.name === 'value')
    if (codePart !== undefined && parameterValueX(codePart) === code && valuePart !== undefined) {
      return parameterValueX(valuePart)
    }
  }
  return undefined
}

function questionFor(model: ModelProvider, questionnaire: TypedValue, answer: TypedValue): TypedValue {
  const responseItem = elementOrigin(answer)?.parent
  const linkId = responseItem === undefined ? undefined : children(model, responseItem, 'linkId')[0]?.value
  const pending = children(model, questionnaire, 'item')
  while (pending.length > 0) {
    const question = pending.pop() as TypedValue
    if (linkId !== undefined && children(model, question, 'linkId')[0]?.value === linkId) return question
    pending.push(...children(model, question, 'item'))
  }
  throw new FhirPathRuntimeError(`weight() cannot find Questionnaire item for linkId '${String(linkId)}'`)
}

function children(model: ModelProvider, item: TypedValue, name: string): TypedValue[] {
  return readModelProperty(model, item, name) ?? []
}
