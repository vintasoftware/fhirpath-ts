import { FhirPathTypeError } from '../errors.ts'
import { functions as builtinFunctions } from '../functions/registry.ts'
import type { ModelProvider } from '../model/provider.ts'
import { SYSTEM_STRING, toCollection, type TypedValue } from '../values/typed-value.ts'

/**
 * The runtime side of a host-supplied function: arity and implementation.
 * The API layer's CustomFunction (api/compile.ts) adds the optional analyzer
 * signature; this module only needs what evaluation uses.
 */
export interface HostFunction {
  /** Inclusive argument count range, checked before invocation. Defaults: 0 to unlimited. */
  minArity?: number
  maxArity?: number
  /**
   * The implementation. `input` is the unwrapped input collection; each
   * argument is eagerly evaluated against `$this` — the enclosing context
   * item, like built-in value arguments — and arrives as an unwrapped
   * collection. Return a plain value, an array of plain values, or undefined
   * for empty — the engine converts back to its typed representation.
   */
  fn: (input: unknown[], ...args: unknown[][]) => unknown
}

/**
 * A pluggable regular-expression engine for matches()/matchesFull()/
 * replaceMatches(). The default is the built-in RegExp, which backtracks and
 * cannot be timed out synchronously — hosts evaluating untrusted expressions
 * can supply a linear-time engine (e.g. an RE2 binding) here instead.
 */
export interface RegexEngine {
  /**
   * Compile `pattern` with `flags` (a subset of 's' and 'g'; matchesFull
   * wraps the pattern in `^(?:...)$` before compiling). Throw on invalid
   * patterns — the engine converts that to the spec's type error.
   */
  compile(
    pattern: string,
    flags: string
  ): {
    test(subject: string): boolean
    /** Replace every match (the 'g' flag is passed for replaceMatches). */
    replace(subject: string, substitution: string): string
  }
}

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
  /** Host-supplied functions by name; never contains a built-in name (createContext rejects overrides). */
  functions: ReadonlyMap<string, HostFunction>
  /** Regex engine for the matches() family; undefined means the built-in RegExp. */
  regex: RegexEngine | undefined
  frame: Frame
}

const BUILTIN_CONSTANTS: ReadonlyMap<string, string> = new Map([
  ['ucum', 'http://unitsofmeasure.org'],
  ['sct', 'http://snomed.info/sct'],
  ['loinc', 'http://loinc.org'],
])

/**
 * Environment variables every evaluation defines. The static analyzer resolves
 * and protects exactly these names, so keep this list next to the code that
 * seeds them (createContext) — a builtin added here is known there for free.
 */
export const BUILTIN_ENV_VARIABLE_NAMES: ReadonlySet<string> = new Set([
  ...BUILTIN_CONSTANTS.keys(),
  'context',
  'resource',
  'rootResource',
])

export function createContext(options: {
  root: TypedValue[]
  env?: Record<string, unknown> | undefined
  model?: ModelProvider | undefined
  now?: Date | undefined
  trace?: ((name: string, values: TypedValue[]) => void) | undefined
  functions?: Record<string, HostFunction> | undefined
  regex?: RegexEngine | undefined
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
  const hostFunctions = new Map<string, HostFunction>()
  for (const [name, fn] of Object.entries(options.functions ?? {})) {
    // Overriding a built-in would silently change spec behavior — fail loudly.
    if (builtinFunctions.has(name)) {
      throw new FhirPathTypeError(`Cannot override the built-in function '${name}'`)
    }
    hostFunctions.set(name, fn)
  }
  return {
    root: options.root,
    env,
    model: options.model,
    now: options.now ?? new Date(),
    trace: options.trace ?? (() => {}),
    variables: new Map(),
    functions: hostFunctions,
    regex: options.regex,
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
