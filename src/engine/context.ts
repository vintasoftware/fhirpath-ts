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
}): EvaluationContext {
  const env = new Map<string, TypedValue[]>()
  for (const [name, url] of BUILTIN_CONSTANTS) {
    env.set(name, [{ type: SYSTEM_STRING, value: url }])
  }
  env.set('context', options.root)
  for (const [name, value] of Object.entries(options.env ?? {})) {
    env.set(name.startsWith('%') ? name.slice(1) : name, toCollection(value))
  }
  return {
    root: options.root,
    env,
    model: options.model,
    now: options.now ?? new Date(),
    frame: { parent: undefined, thisValue: options.root, index: undefined, total: undefined },
  }
}

/** Resolve `%name`; referencing an undefined environment variable is an error (spec §9). */
export function resolveEnvironmentVariable(context: EvaluationContext, name: string): TypedValue[] {
  const value = context.env.get(name)
  if (value === undefined) {
    throw new FhirPathTypeError(`Undefined environment variable %${name}`)
  }
  return value
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
  return body({ ...context, frame: child })
}
