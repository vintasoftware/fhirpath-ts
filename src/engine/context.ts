import { FhirPathTypeError } from '../errors'
import type { ModelProvider } from '../model/provider'
import { SYSTEM_STRING, type TypedValue, toCollection } from '../values/typed-value'

/** `$this` / `$index` / `$total` bindings; iteration functions push one frame per element. */
export interface Frame {
  parent: Frame | undefined
  thisValue: TypedValue[]
  index: number | undefined
  total: TypedValue[] | undefined
}

export interface EvaluationContext {
  /** The original input node: `%context`. */
  root: TypedValue[]
  /** Environment variables by name (without the `%`). Values are collections. */
  env: ReadonlyMap<string, TypedValue[]>
  model: ModelProvider | undefined
  /** Fixed evaluation clock so now()/today()/timeOfDay() are stable within one evaluation. */
  now: Date
  /**
   * Sink for trace(). Default is a no-op: traced values may contain patient data,
   * so writing them to console or log files is the caller's deliberate choice.
   */
  trace: (name: string, values: TypedValue[]) => void
  /**
   * Variables from defineVariable(). The map is local to one expression chain:
   * dots thread it along, while operator operands, function arguments, and
   * iteration frames evaluate against a copy (see forkVariables).
   */
  variables: Map<string, TypedValue[]>
  frame: Frame
}

const BUILTIN_CONSTANTS: ReadonlyMap<string, string> = new Map([
  ['ucum', 'http://unitsofmeasure.org'],
  ['sct', 'http://snomed.info/sct'],
  ['loinc', 'http://loinc.org'],
])

export function createContext(options: {
  root: TypedValue[]
  env?: Record<string, unknown> | undefined
  model?: ModelProvider | undefined
  now?: Date | undefined
  trace?: ((name: string, values: TypedValue[]) => void) | undefined
}): EvaluationContext {
  const env = new Map<string, TypedValue[]>()
  for (const [name, url] of BUILTIN_CONSTANTS) {
    env.set(name, [{ type: SYSTEM_STRING, value: url }])
  }
  env.set('context', options.root)
  // FHIR-defined variables; contained-resource re-rooting is a later refinement.
  env.set('resource', options.root)
  env.set('rootResource', options.root)
  for (const [name, value] of Object.entries(options.env ?? {})) {
    env.set(name.startsWith('%') ? name.slice(1) : name, toCollection(value))
  }
  return {
    root: options.root,
    env,
    model: options.model,
    now: options.now ?? new Date(),
    trace: options.trace ?? (() => {}),
    variables: new Map(),
    frame: { parent: undefined, thisValue: options.root, index: undefined, total: undefined },
  }
}

/** A context whose defineVariable() scope is detached from the parent chain. */
export function forkVariables(context: EvaluationContext): EvaluationContext {
  return { ...context, variables: new Map(context.variables) }
}

/** Resolve `%name`; referencing an undefined environment variable is an error (spec §9). */
export function resolveEnvironmentVariable(context: EvaluationContext, name: string): TypedValue[] {
  const value = context.variables.get(name) ?? context.env.get(name)
  if (value !== undefined) {
    return value
  }
  // FHIR-defined families: %`vs-[name]` and %`ext-[name]` expand to HL7 urls.
  if (name.startsWith('vs-')) {
    return [{ type: SYSTEM_STRING, value: `http://hl7.org/fhir/ValueSet/${name.slice(3)}` }]
  }
  if (name.startsWith('ext-')) {
    return [{ type: SYSTEM_STRING, value: `http://hl7.org/fhir/StructureDefinition/${name.slice(4)}` }]
  }
  throw new FhirPathTypeError(`Undefined environment variable %${name}`)
}

/** Run `body` with a frame binding `$this` (and optionally `$index` / `$total`). */
export function withFrame<T>(
  context: EvaluationContext,
  frame: { thisValue: TypedValue[]; index?: number; total?: TypedValue[] },
  body: (context: EvaluationContext) => T
): T {
  const child: Frame = {
    parent: context.frame,
    thisValue: frame.thisValue,
    index: frame.index,
    total: frame.total,
  }
  return body({ ...context, frame: child, variables: new Map(context.variables) })
}
