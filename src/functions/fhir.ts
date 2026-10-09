import { FhirPathRuntimeError, FhirPathTypeError } from '../errors.ts'
import { childValue } from '../fhir/element-origin.ts'
import { extensionsOf } from '../fhir/extensions.ts'
import { validateNarrative } from '../fhir/html-checks.ts'
import { singleton, wrapBoolean } from '../values/collection.ts'
import { calendarToUcumLoose, compareQuantities, promoteQuantity } from '../values/quantity.ts'
import { SYSTEM_QUANTITY, SYSTEM_STRING, systemTypeOf, type TypedValue } from '../values/typed-value.ts'
import { argAt, registerFunction } from './registry.ts'

/** extension(url): extensions of each item, including primitive `_field` extensions. */
registerFunction('extension', {
  minArity: 1,
  maxArity: 1,
  evaluate: (context, input, args, evaluateNode) => {
    const urlValue = singleton(evaluateNode(argAt(args, 0), context, input))
    if (urlValue === undefined) {
      return []
    }
    if (systemTypeOf(urlValue) !== SYSTEM_STRING) {
      throw new FhirPathTypeError('extension() expects a String url argument')
    }
    const url = urlValue.value as string
    const result: TypedValue[] = []
    for (const item of input) {
      for (const extension of extensionsOf(item)) {
        if ((extension as { url?: unknown }).url === url) {
          result.push(childValue({ type: 'FHIR.Extension', value: extension }, item, 'extension'))
        }
      }
    }
    return result
  },
})

/**
 * True when the input holds a single primitive with an actual value; a multi-item
 * input is "not a single value" (FHIR spec wording), so false — not an error.
 */
registerFunction('hasValue', {
  minArity: 0,
  maxArity: 0,
  evaluate: (_context, input) => {
    if (input.length === 0) {
      return []
    }
    if (input.length > 1) {
      return wrapBoolean(false)
    }
    const item = input[0] as TypedValue
    return wrapBoolean(
      systemTypeOf(item) !== undefined &&
        item.type !== SYSTEM_QUANTITY &&
        item.value !== undefined &&
        item.value !== null
    )
  },
})

registerFunction('getValue', {
  minArity: 0,
  maxArity: 0,
  evaluate: (_context, input) => {
    if (input.length !== 1) {
      return []
    }
    const item = input[0] as TypedValue
    if (systemTypeOf(item) === undefined || item.value === undefined) {
      return []
    }
    return [{ type: systemTypeOf(item) as string, value: item.value }]
  },
})

/**
 * Validate narrative against the FHIR rules. An xhtml element is checked as the
 * whole Narrative.div; a string, including a model subtype of FHIR.string such
 * as markdown or code, is checked as the content of a div (FHIR-56303). Any
 * other item, or more than one item, gives empty. A configured narrative
 * sanitizer must also accept the narrative.
 */
registerFunction('htmlChecks', {
  minArity: 0,
  maxArity: 0,
  evaluate: (context, input) => {
    const item = input.length === 1 ? (input[0] as TypedValue) : undefined
    if (typeof item?.value !== 'string') {
      return []
    }
    let narrative: string
    if (item.type === 'FHIR.xhtml') {
      narrative = item.value
    } else if (item.type === SYSTEM_STRING || context.model?.isSubtypeOf(item.type, 'FHIR.string') === true) {
      narrative = `<div xmlns="http://www.w3.org/1999/xhtml">${item.value}</div>`
    } else {
      return []
    }
    return wrapBoolean(validateNarrative(narrative) && (context.narrativeSanitizer?.accepts(narrative) ?? true))
  },
})

/** Quantities are comparable when their units share a dimension (FHIR R5 addition). */
registerFunction('comparable', {
  minArity: 1,
  maxArity: 1,
  evaluate: (context, input, args, evaluateNode) => {
    const left = singleton(input)
    const right = singleton(evaluateNode(argAt(args, 0), context, input))
    if (left === undefined || right === undefined) {
      return []
    }
    const a = promoteQuantity(left)
    const b = promoteQuantity(right)
    if (!(a && b)) {
      throw new FhirPathTypeError('comparable() expects Quantity operands')
    }
    // Dimensions decide comparability, so calendar durations count as their
    // loose UCUM twins: 1 year.comparable(1 second) is true.
    return wrapBoolean(compareQuantities(calendarToUcumLoose(a), calendarToUcumLoose(b)) !== undefined)
  },
})

/**
 * Base-StructureDefinition conformance only: the url must name a core resource type.
 * Real profile validation is a deferred feature (README register).
 */
registerFunction('conformsTo', {
  minArity: 1,
  maxArity: 1,
  evaluate: (context, input, args, evaluateNode) => {
    const item = singleton(input)
    if (item === undefined) {
      return []
    }
    const urlValue = singleton(evaluateNode(argAt(args, 0), context, input))
    const url = typeof urlValue?.value === 'string' ? urlValue.value : ''
    const match = /^http:\/\/hl7\.org\/fhir\/StructureDefinition\/([A-Za-z]+)$/.exec(url)
    if (!match) {
      throw new FhirPathRuntimeError(`conformsTo() only supports base StructureDefinition urls, got '${url}'`)
    }
    const resourceType = (item.value as { resourceType?: unknown } | undefined)?.resourceType
    return wrapBoolean(resourceType === match[1])
  },
})

/** Deferred features (see the README register): registered so they fail with a clear message. */
function unsupported(name: string, minArity: number, maxArity: number, reason: string): void {
  registerFunction(name, {
    minArity,
    maxArity,
    evaluate: () => {
      throw new FhirPathRuntimeError(`${name}() is not supported in v1: ${reason}`)
    },
  })
}

unsupported('slice', 2, 2, 'profile slicing needs profile definitions')
unsupported('elementDefinition', 0, 0, 'element definitions need profile definitions')
unsupported('checkModifiers', 0, 1, 'modifier checking needs profile definitions')
