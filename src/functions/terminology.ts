import { requestAsync } from '../engine/async.ts'
import type { EvaluationContext } from '../engine/context.ts'
import { FhirPathRuntimeError, FhirPathTypeError } from '../errors.ts'
import type { AstNode } from '../parser/ast.ts'
import { isTerminologyService, type TerminologyProvider } from '../terminology/provider.ts'
import { singleton, wrapBoolean } from '../values/collection.ts'
import { Decimal } from '../values/decimal.ts'
import { SYSTEM_DECIMAL, SYSTEM_STRING, systemTypeOf, type TypedValue, toCollection } from '../values/typed-value.ts'
import { argAt, describeArity, registerFunction } from './registry.ts'

type EvaluateNode = (node: AstNode, context: EvaluationContext, input: TypedValue[]) => TypedValue[]

/**
 * memberOf(valueset): whether the input code/Coding/CodeableConcept is in the
 * value set, per the provider's ValueSet/$validate-code. A response without a
 * boolean `result` means the service could not determine membership → empty.
 */
registerFunction('memberOf', {
  minArity: 1,
  maxArity: 1,
  evaluate: (context, input, args, evaluateNode) => {
    const item = singleton(input)
    if (item === undefined) {
      return []
    }
    const url = stringArgument('memberOf', 'a String valueset url', evaluateNode(argAt(args, 0), context, input))
    if (url === undefined) {
      return []
    }
    const coded = codedValueOf(item)
    if (coded === undefined) {
      throw new FhirPathTypeError('memberOf() expects a code, Coding, or CodeableConcept input')
    }
    const response = callProvider(context, 'memberOf()', 'validateVS', [url, coded])
    const result = parameterValue(response, 'result')
    return typeof result === 'boolean' ? wrapBoolean(result) : []
  },
})

/**
 * Both spec forms of subsumes share this name: `Coding.subsumes(coded)` returns
 * a Boolean, and `%terminologies.subsumes(system, coded1, coded2 [, params])`
 * returns the raw outcome code. The input decides which one runs.
 */
registerFunction('subsumes', {
  minArity: 1,
  maxArity: 4,
  evaluate: (context, input, args, evaluateNode) => {
    if (isTerminologyService(input)) {
      return serviceSubsumes(context, input, args, evaluateNode)
    }
    requireArity('subsumes', args, 1, 1)
    return codingSubsumes(
      context,
      'subsumes',
      input,
      args,
      evaluateNode,
      outcome => outcome === 'equivalent' || outcome === 'subsumes'
    )
  },
})

registerFunction('subsumedBy', {
  minArity: 1,
  maxArity: 1,
  evaluate: (context, input, args, evaluateNode) =>
    codingSubsumes(
      context,
      'subsumedBy',
      input,
      args,
      evaluateNode,
      outcome => outcome === 'equivalent' || outcome === 'subsumed-by'
    ),
})

/**
 * The Boolean Coding|CodeableConcept form: true when any same-system coding pair
 * satisfies `accepts` on the provider's CodeSystem/$subsumes outcome. Codings in
 * different systems (or without one) cannot subsume each other, so those pairs
 * are skipped — sides with no comparable pair yield false. A side with no coding
 * at all yields empty, mirroring memberOf's cannot-determine rule.
 */
function codingSubsumes(
  context: EvaluationContext,
  name: string,
  input: TypedValue[],
  args: AstNode[],
  evaluateNode: EvaluateNode,
  accepts: (outcome: unknown) => boolean
): TypedValue[] {
  const item = singleton(input)
  const other = singleton(evaluateNode(argAt(args, 0), context, input))
  if (item === undefined || other === undefined) {
    return []
  }
  const inputCodings = codingsOf(item.value)
  const argCodings = codingsOf(other.value)
  if (inputCodings.length === 0 || argCodings.length === 0) {
    return []
  }
  for (const a of inputCodings) {
    for (const b of argCodings) {
      if (typeof a.system !== 'string' || a.system !== b.system) {
        continue
      }
      const outcome = callProvider(context, `${name}()`, 'subsumes', [a.system, a, b])
      if (accepts(outcome)) {
        return wrapBoolean(true)
      }
    }
  }
  return wrapBoolean(false)
}

/** The `%terminologies.subsumes(system, coded1, coded2 [, params])` form: returns the outcome code. */
function serviceSubsumes(
  context: EvaluationContext,
  input: TypedValue[],
  args: AstNode[],
  evaluateNode: EvaluateNode
): TypedValue[] {
  requireArity('subsumes', args, 3, 4)
  const system = stringArgument('subsumes', 'a String system', evaluateNode(argAt(args, 0), context, input))
  const coded1 = codedValueOf(singleton(evaluateNode(argAt(args, 1), context, input)))
  const coded2 = codedValueOf(singleton(evaluateNode(argAt(args, 2), context, input)))
  const params = optionalParams('subsumes', context, input, args, 3, evaluateNode)
  if (system === undefined || coded1 === undefined || coded2 === undefined) {
    return []
  }
  const outcome = callProvider(
    context,
    'subsumes()',
    'subsumes',
    params === undefined ? [system, coded1, coded2] : [system, coded1, coded2, params]
  )
  return typeof outcome === 'string' ? [{ type: SYSTEM_STRING, value: outcome }] : []
}

/**
 * The rest of the %terminologies API. Each maps one-to-one onto a provider
 * method; a missing required argument yields empty (the service cannot answer),
 * and an undefined response yields empty.
 */
function registerServiceFunction(name: keyof TerminologyProvider, requiredArgs: number): void {
  registerFunction(name, {
    minArity: requiredArgs,
    maxArity: requiredArgs + 1,
    evaluate: (context, input, args, evaluateNode) => {
      if (!isTerminologyService(input)) {
        throw new FhirPathTypeError(`${name}() is only available on %terminologies`)
      }
      const values: unknown[] = []
      for (let index = 0; index < requiredArgs; index++) {
        const value = singleton(evaluateNode(argAt(args, index), context, input))?.value
        if (value === undefined) {
          return []
        }
        values.push(value)
      }
      const params = optionalParams(name, context, input, args, requiredArgs, evaluateNode)
      if (params !== undefined) {
        values.push(params)
      }
      // The one dynamic caller: the loop builds the tuple positionally, so the
      // per-method arg typing callProvider gives static callers is asserted here.
      const response = callProvider(context, `${name}()`, name, values as ProviderArgs<typeof name>)
      return toCollection(response)
    },
  })
}

registerServiceFunction('expand', 1)
registerServiceFunction('lookup', 1)
registerServiceFunction('validateVS', 2)
registerServiceFunction('validateCS', 2)
registerServiceFunction('translate', 2)

/**
 * weight(): the ordinal value of each input coded element. The itemWeight
 * extension (or its R4 predecessor ordinalValue) answers synchronously; without
 * one, a Coding's CodeSystem is asked for its itemWeight property via the
 * provider's $lookup. Questionnaire answerOption weights (which need the
 * source Questionnaire, not just the answer) are out of scope.
 */
const WEIGHT_EXTENSION_URLS = [
  'http://hl7.org/fhir/StructureDefinition/itemWeight',
  'http://hl7.org/fhir/StructureDefinition/ordinalValue',
]

registerFunction('weight', {
  minArity: 0,
  maxArity: 0,
  evaluate: (context, input) => {
    const result: TypedValue[] = []
    for (const item of input) {
      const weight = weightOf(context, item)
      if (weight !== undefined) {
        result.push({ type: SYSTEM_DECIMAL, value: weight })
      }
    }
    return result
  },
})

function weightOf(context: EvaluationContext, item: TypedValue): Decimal | undefined {
  if (!isObject(item.value)) {
    throw new FhirPathTypeError('weight() expects Coding or CodeableConcept inputs')
  }
  // The element itself, then (for a CodeableConcept) each of its codings.
  const element = item.value as CodedElement
  const carriers = [element, ...codingsOf(element).filter(c => c !== element)]
  for (const carrier of carriers) {
    const extension = weightExtensionValue(carrier)
    if (extension !== undefined) {
      return toDecimal(extension)
    }
  }
  for (const coding of codingsOf(item.value)) {
    if (typeof coding.system !== 'string' || typeof coding.code !== 'string') {
      continue
    }
    const { system, code } = coding
    const response = callProvider(context, 'weight()', 'lookup', [{ system, code }, 'property=itemWeight'])
    const property = lookupProperty(response, 'itemWeight')
    if (property !== undefined) {
      return toDecimal(property)
    }
  }
  return undefined
}

function weightExtensionValue(carrier: CodedElement): unknown {
  const extensions = Array.isArray(carrier.extension) ? carrier.extension : []
  for (const extension of extensions) {
    if (!isObject(extension)) {
      continue
    }
    const { url, valueDecimal } = extension as { url?: unknown; valueDecimal?: unknown }
    if (typeof url === 'string' && WEIGHT_EXTENSION_URLS.includes(url)) {
      return valueDecimal
    }
  }
  return undefined
}

function toDecimal(value: unknown): Decimal | undefined {
  return typeof value === 'number' ? Decimal.fromNumber(value) : undefined
}

// ---- shared helpers ----

type ProviderArgs<K extends keyof TerminologyProvider> = Parameters<NonNullable<TerminologyProvider[K]>>

/**
 * One terminology-provider call: the async request is cached by exactly
 * (method, arguments) — the same rendering the tx fixture recorder uses — so
 * identical requests from different functions share one provider round-trip
 * and cache keys cannot drift per call site. The two configuration failures
 * are named: no provider at all, or a provider without this operation.
 */
function callProvider<K extends keyof TerminologyProvider>(
  context: EvaluationContext,
  what: string,
  method: K,
  args: ProviderArgs<K>
): unknown {
  const provider = context.terminology
  if (!provider) {
    throw new FhirPathRuntimeError(`${what} needs a terminology provider (pass options.terminology)`)
  }
  const impl = provider[method]
  if (!impl) {
    throw new FhirPathRuntimeError(`the terminology provider does not implement ${method}()`)
  }
  return requestAsync(context, what, `${method}|${JSON.stringify(args)}`, () =>
    (impl as (...callArgs: unknown[]) => Promise<unknown>).apply(provider, args)
  )
}

/**
 * A coded value as the provider receives it: a code string, or a Coding /
 * CodeableConcept object passed through as plain JSON.
 */
function codedValueOf(item: TypedValue | undefined): unknown {
  if (item === undefined) {
    return undefined
  }
  if (typeof item.value === 'string' || isObject(item.value)) {
    return item.value
  }
  return undefined
}

/** The shape shared by Codings, CodeableConcepts, and their extension carriers. */
interface CodedElement {
  system?: unknown
  code?: unknown
  coding?: unknown
  extension?: unknown
}

/** The Codings inside a value: a Coding is itself, a CodeableConcept contributes its coding list. */
function codingsOf(value: unknown): CodedElement[] {
  if (!isObject(value)) {
    return []
  }
  const element = value as CodedElement
  if (Array.isArray(element.coding)) {
    return element.coding.filter(isObject) as CodedElement[]
  }
  // A Coding proper: `code`/`system` are strings. A resource that merely has a
  // `code` element (e.g. Observation) is not one, and yields no codings.
  return typeof element.code === 'string' || typeof element.system === 'string' ? [element] : []
}

interface ParameterEntry {
  name?: unknown
  part?: unknown
}

/** `parameter.where(name = $name)` value from a Parameters resource, e.g. validate-code's `result`. */
function parameterValue(parameters: unknown, name: string): unknown {
  const entry = parameterList(parameters).find(parameter => parameter.name === name)
  return entry === undefined ? undefined : parameterValueX(entry)
}

/** A $lookup property part value, e.g. the itemWeight ordinal. */
function lookupProperty(parameters: unknown, code: string): unknown {
  for (const parameter of parameterList(parameters)) {
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

function parameterList(parameters: unknown): ParameterEntry[] {
  if (!isObject(parameters)) {
    return []
  }
  const resource = parameters as { resourceType?: unknown; parameter?: unknown }
  if (resource.resourceType !== 'Parameters' || !Array.isArray(resource.parameter)) {
    return []
  }
  return resource.parameter.filter(isObject) as ParameterEntry[]
}

/** The value[x] of a Parameters parameter or part. */
function parameterValueX(entry: object): unknown {
  for (const [key, value] of Object.entries(entry)) {
    if (key.startsWith('value')) {
      return value
    }
  }
  return undefined
}

function stringArgument(name: string, expected: string, values: TypedValue[]): string | undefined {
  const value = singleton(values)
  if (value === undefined) {
    return undefined
  }
  if (systemTypeOf(value) !== SYSTEM_STRING) {
    throw new FhirPathTypeError(`${name}() expects ${expected} argument`)
  }
  return value.value as string
}

/** The trailing URL-encoded `params` string argument the tx API functions accept. */
function optionalParams(
  name: string,
  context: EvaluationContext,
  input: TypedValue[],
  args: AstNode[],
  index: number,
  evaluateNode: EvaluateNode
): string | undefined {
  if (args.length <= index) {
    return undefined
  }
  return stringArgument(name, 'a String params', evaluateNode(argAt(args, index), context, input))
}

/** Both subsumes forms live under one registry entry, so each form re-checks its own arity. */
function requireArity(name: string, args: AstNode[], min: number, max: number): void {
  if (args.length < min || args.length > max) {
    throw new FhirPathTypeError(`Function '${name}' expects ${describeArity(min, max)}, got ${args.length} arguments`)
  }
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}
