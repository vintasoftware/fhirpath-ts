import { randomUUID } from 'node:crypto'

import type { Extension, Questionnaire, QuestionnaireItem, QuestionnaireResponse } from '@medplum/fhirtypes'

import { Decimal, Temporal, type TypedValue } from '../../src/index.ts'
import { evaluateFocus, type Focus, responseFocus } from './focus.ts'

const prefix = 'http://hl7.org/fhir/uv/sdc/StructureDefinition/sdc-questionnaire-'
type ObjectValue = Record<string, unknown>

function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function extensions(node: ObjectValue, name: string): Extension[] {
  return ((node['extension'] ?? []) as Extension[]).filter(ext => ext.url === prefix + name)
}

function expression(ext: Extension): string {
  if (ext.valueExpression) {
    if (ext.valueExpression.language !== 'text/fhirpath' || !ext.valueExpression.expression) {
      throw new Error('The prototype only evaluates text/fhirpath expressions')
    }
    return ext.valueExpression.expression
  }
  if (ext.valueString !== undefined) {
    return ext.valueString
  }
  throw new Error(`Missing expression on ${ext.url}`)
}

function plain(value: TypedValue): unknown {
  if (value.value instanceof Decimal) {
    return value.value.toNumber()
  }
  if (value.value instanceof Temporal) {
    return value.value.toString()
  }
  return structuredClone(value.value)
}

function single(values: unknown[], label: string): unknown {
  if (values.length > 1) {
    throw new Error(`${label}: multiple values for a singleton template property`)
  }
  return values[0]
}

function scopes(node: ObjectValue, focus: Focus): Focus[] {
  const contexts = extensions(node, 'templateExtractContext')
  if (contexts.length > 1) {
    throw new Error('Multiple context extensions are outside this prototype')
  }
  const context = contexts[0]
  if (!context) {
    return [focus]
  }
  const name = context.valueExpression?.name
  return evaluateFocus(expression(context), focus).map(value => ({
    ...focus,
    values: [value],
    bindings: name ? { ...focus.bindings, [name]: [value] } : focus.bindings,
  }))
}

function withoutInstructions(node: ObjectValue): ObjectValue {
  const result = { ...node }
  const remaining = ((result['extension'] ?? []) as Extension[]).filter(
    ext => ext.url !== `${prefix}templateExtractContext` && ext.url !== `${prefix}templateExtractValue`
  )
  if (remaining.length) {
    result['extension'] = remaining
  } else {
    delete result['extension']
  }
  return result
}

/** Primitive value and _value metadata occupy one slot in the template. */
function primitive(meta: ObjectValue, original: unknown, focus: Focus): { value: unknown; meta: ObjectValue }[] {
  return scopes(meta, focus).flatMap(scope => {
    const values = extensions(meta, 'templateExtractValue')
    if (values.length > 1) {
      throw new Error('Multiple value extensions are outside this prototype')
    }
    const value = values[0]
    const results = value ? evaluateFocus(expression(value), scope).map(plain) : [original]
    return results.map(result => ({ value: result, meta: withoutInstructions(meta) }))
  })
}

function render(node: unknown, focus: Focus): unknown[] {
  if (!object(node)) {
    return [structuredClone(node)]
  }
  return scopes(node, focus).flatMap(scope => {
    const values = extensions(node, 'templateExtractValue')
    if (values.length > 1) {
      throw new Error('Multiple value extensions are outside this prototype')
    }
    if (values[0]) {
      return evaluateFocus(expression(values[0]), scope).map(plain)
    }
    const result: ObjectValue = {}
    const clean = withoutInstructions(node)
    for (const [key, child] of Object.entries(clean)) {
      if (!key.startsWith('_') && Object.hasOwn(clean, `_${key}`)) {
        continue
      }
      if (key.startsWith('_')) {
        const property = key.slice(1)
        const original = clean[property]
        const metadata = Array.isArray(child)
          ? Array.from(
              { length: Math.max(child.length, Array.isArray(original) ? original.length : 0) },
              (_, index) => child[index] ?? {}
            )
          : [child]
        const slots = metadata.flatMap((meta, index) =>
          primitive(meta as ObjectValue, Array.isArray(original) ? original[index] : original, scope)
        )
        if (!slots.length) {
          continue
        }
        const output = slots.map(slot => slot.value)
        const sidecars = slots.map(slot => (Object.keys(slot.meta).length ? slot.meta : null))
        result[property] = Array.isArray(child) ? output : single(output, property)
        if (sidecars.some(Boolean)) {
          result[key] = Array.isArray(child) ? sidecars : sidecars[0]
        }
      } else {
        const output = Array.isArray(child) ? child.flatMap(value => render(value, scope)) : render(child, scope)
        if (output.length) {
          result[key] = Array.isArray(child) ? output : single(output, key)
        }
      }
    }
    return [result]
  })
}

/**
 * Offline template-extraction experiment, not a complete $extract operation.
 * Throws on evaluation errors; does not validate generated resources or execute requests.
 */
export function extractTemplates(
  questionnaire: Questionnaire,
  response: QuestionnaireResponse,
  allocateId: () => string = () => `urn:uuid:${randomUUID()}`
): ObjectValue {
  const entries: ObjectValue[] = []
  const template = (reference: string | undefined): ObjectValue => {
    const found = questionnaire.contained?.find(resource => `#${resource.id}` === reference)
    if (!found) {
      throw new Error(`Missing contained template ${reference}`)
    }
    const copy = structuredClone(found) as unknown as ObjectValue
    delete copy['id']
    return copy
  }

  function visit(node: Questionnaire | QuestionnaireItem, focus: Focus): void {
    const record = node as unknown as ObjectValue
    const answer = (focus.values[0]?.value as { answer?: unknown[] } | undefined)?.answer
    if (extensions(record, 'templateExtract').length && answer && answer.length > 1) {
      throw new Error('Resource extraction per repeated answer is outside this prototype')
    }
    const env = { ...focus.env }
    for (const allocation of extensions(record, 'extractAllocateId')) {
      const name = allocation.valueString
      if (!name || name in env || name in focus.bindings || name === 'sdcFocus' || name === 'context') {
        throw new Error('An allocated ID must have a distinct variable name')
      }
      env[name] = allocateId()
    }
    const scoped = { ...focus, env }
    for (const ext of extensions(record, 'templateExtractBundle')) {
      const bundle = single(render(template(ext.valueReference?.reference), scoped), 'Bundle') as ObjectValue
      entries.push(...((bundle?.['entry'] ?? []) as ObjectValue[]))
    }
    for (const ext of extensions(record, 'templateExtract')) {
      const parts = ext.extension ?? []
      const source = template(parts.find(part => part.url === 'template')?.valueReference?.reference)
      const property = (name: string): unknown => {
        const part = parts.find(value => value.url === name)
        return part ? single(evaluateFocus(expression(part), scoped).map(plain), name) : undefined
      }
      for (const resource of render(source, scoped) as ObjectValue[]) {
        const id = property('resourceId')
        if (id !== undefined) {
          resource['id'] = id
        }
        const request: ObjectValue = {
          method: id === undefined ? 'POST' : 'PUT',
          url: id === undefined ? resource['resourceType'] : `${resource['resourceType']}/${id}`,
        }
        for (const name of ['ifNoneMatch', 'ifModifiedSince', 'ifMatch', 'ifNoneExist']) {
          const value = property(name)
          if (value !== undefined) {
            request[name] = value
          }
        }
        entries.push({ fullUrl: property('fullUrl') ?? allocateId(), resource, request })
      }
    }
    for (const item of node.item ?? []) {
      const linkId = item.linkId.replaceAll('\\', '\\\\').replaceAll("'", "\\'")
      const matches = evaluateFocus(`item.combine(answer.item).where(linkId = '${linkId}')`, scoped)
      for (const match of matches) {
        visit(item, { ...scoped, values: [match] })
      }
    }
  }

  visit(questionnaire, responseFocus(response, questionnaire))
  return { resourceType: 'Bundle', type: 'transaction', entry: entries }
}
