import { requestAsync } from '../engine/async.ts'
import type { EvaluationContext } from '../engine/context.ts'
import { FhirPathRuntimeError, FhirPathTypeError } from '../errors.ts'
import type { AstNode } from '../parser/ast.ts'
import { isTerminologyService, type TerminologyProvider } from '../terminology/provider.ts'
import { singleton, wrapBoolean } from '../values/collection.ts'
import { OBJECT_TYPE, SYSTEM_STRING, systemTypeOf, toCollection, type TypedValue } from '../values/typed-value.ts'
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
    const item = input.length === 1 ? input[0] : undefined
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
      return evaluateService('subsumes', context, input, args, evaluateNode)
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
 * different systems, or with an unknown service outcome, remain indeterminate.
 * A matching pair establishes true. Otherwise subsumedBy rejects unrelated
 * systems, while subsumes and unknown service outcomes yield empty.
 */
function codingSubsumes(
  context: EvaluationContext,
  name: 'subsumes' | 'subsumedBy',
  input: TypedValue[],
  args: AstNode[],
  evaluateNode: EvaluateNode,
  accepts: (outcome: unknown) => boolean
): TypedValue[] {
  const argument = evaluateNode(argAt(args, 0), context, input)
  const item = input.length === 1 ? input[0] : undefined
  const other = argument.length === 1 ? argument[0] : undefined
  if (item === undefined || other === undefined) {
    return []
  }
  const inputCodings = codingsOf(item.value)
  const argCodings = codingsOf(other.value)
  if (inputCodings.length === 0 || argCodings.length === 0) {
    return []
  }
  let unknown = false
  let differentSystems = false
  for (const a of inputCodings) {
    for (const b of argCodings) {
      if (typeof a.system === 'string' && typeof b.system === 'string' && a.system !== b.system) {
        differentSystems = true
      }
      if (
        typeof a.system !== 'string' ||
        a.system !== b.system ||
        typeof a.code !== 'string' ||
        typeof b.code !== 'string'
      ) {
        unknown = true
        continue
      }
      const outcome = callProvider(context, `${name}()`, 'subsumes', [a.system, a, b])
      if (accepts(outcome)) {
        return wrapBoolean(true)
      }
      if (outcome !== 'equivalent' && outcome !== 'subsumes' && outcome !== 'subsumed-by' && outcome !== 'not-subsumed')
        unknown = true
    }
  }
  if (differentSystems && name === 'subsumedBy') {
    throw new FhirPathRuntimeError('subsumedBy() cannot determine the relationship between different code systems')
  }
  return unknown ? [] : wrapBoolean(false)
}

// The last argument is optional in this API; an explicitly empty argument is
// still invalid, as are all other empty, plural, or wrongly typed arguments.
type ServiceArgument = 'string' | 'code' | 'coded' | 'ValueSet' | 'CodeSystem' | 'ConceptMap'
const SERVICE_ARGUMENTS = {
  expand: ['ValueSet', 'string'],
  lookup: ['coded', 'string'],
  validateVS: ['ValueSet', 'coded', 'string'],
  validateCS: ['CodeSystem', 'coded', 'string'],
  subsumes: ['string', 'code', 'code', 'string'],
  translate: ['ConceptMap', 'code', 'string'],
} as const satisfies Record<keyof TerminologyProvider, readonly ServiceArgument[]>

function evaluateService(
  name: keyof TerminologyProvider,
  context: EvaluationContext,
  input: TypedValue[],
  args: AstNode[],
  evaluateNode: EvaluateNode
): TypedValue[] {
  if (!isTerminologyService(input)) {
    throw new FhirPathTypeError(`${name}() is only available on %terminologies`)
  }
  const kinds = SERVICE_ARGUMENTS[name]
  requireArity(name, args, kinds.length - 1, kinds.length)
  const values: unknown[] = []
  for (let index = 0; index < args.length; index++) {
    const items = evaluateNode(argAt(args, index), context, input)
    const item = items.length === 1 ? items[0] : undefined
    if (item === undefined) return []
    const kind = kinds[index] as ServiceArgument
    const value = serviceArgument(item, kind)
    if (value === undefined) return []
    values.push(value)
  }
  // The argument schema above builds the provider tuple positionally.
  return toCollection(callProvider(context, `${name}()`, name, values as ProviderArgs<typeof name>))
}

function serviceArgument(item: TypedValue, kind: ServiceArgument): unknown {
  if (kind === 'code' || kind === 'coded') return codedValueOf(item, kind === 'coded')
  if (systemTypeOf(item) === SYSTEM_STRING) return item.value
  if (kind !== 'string' && item.type === `FHIR.${kind}`) return item.value
  return undefined
}

for (const name of ['expand', 'lookup', 'validateVS', 'validateCS', 'translate'] as const) {
  const arity = SERVICE_ARGUMENTS[name].length
  registerFunction(name, {
    minArity: arity - 1,
    maxArity: arity,
    evaluate: (context, input, args, evaluateNode) => evaluateService(name, context, input, args, evaluateNode),
  })
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
export function callProvider<K extends keyof TerminologyProvider>(
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
function codedValueOf(item: TypedValue | undefined, allowConcept = true): unknown {
  if (item === undefined) return undefined
  if (systemTypeOf(item) === SYSTEM_STRING || item.type === 'FHIR.Coding') return item.value
  if (allowConcept && item.type === 'FHIR.CodeableConcept') return item.value
  if (item.type !== OBJECT_TYPE || !isObject(item.value)) return undefined
  const value = item.value as CodedElement
  if (typeof value.code === 'string' || typeof value.system === 'string') return value
  return allowConcept && Array.isArray(value.coding) ? value : undefined
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
export function lookupProperty(parameters: unknown, code: string): unknown {
  if (!isObject(parameters) || (parameters as { resourceType?: unknown }).resourceType !== 'Parameters') {
    throw new FhirPathRuntimeError('weight() cannot resolve the CodeSystem')
  }
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

/** Both subsumes forms share a registry entry, so the selected form checks its arity. */
function requireArity(name: string, args: AstNode[], min: number, max: number): void {
  if (args.length < min || args.length > max) {
    throw new FhirPathTypeError(`Function '${name}' expects ${describeArity(min, max)}, got ${args.length} arguments`)
  }
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}
