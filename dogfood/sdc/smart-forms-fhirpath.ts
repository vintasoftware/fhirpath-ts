/**
 * The fhirpath.js call shape Smart Forms uses, on fhirpath-ts. One module
 * holds every translation: argument order, the fixed R4 model, the explicit
 * fragment type of `{ base, expression }`, typed results carried between
 * calls, and the host services behind fhirpath.js's `async`, `terminologyUrl`,
 * and `fhirServerUrl` options. A build alias from `fhirpath` to this module
 * replaces the engine without touching the call sites; the Smart Forms edits
 * that remain are listed in docs/sdc-readiness.md.
 */
import {
  type AstNode,
  compile,
  FhirPathAsyncRequiredError,
  type FhirTypeName,
  type ReferenceResolver,
  type TerminologyProvider,
  type TypedValue,
} from '../../src/index.ts'
import { r4, r4Model } from '../../src/r4/index.ts'
import {
  fhirClient,
  type MedplumClientLike,
  medplumResolver,
  medplumTerminology,
} from '../../src/terminology/medplum.ts'

/** The fhirpath.js options Smart Forms passes. */
export interface EvaluateOptions {
  /** `true` returns a Promise only when the expression needs a service; `'always'` always returns one. */
  async?: boolean | 'always'
  /** `false` returns typed values, which a later call takes as its input or as an environment variable. */
  resolveInternalTypes?: boolean
  terminologyUrl?: string
  fhirServerUrl?: string
}

/** The services an asynchronous evaluation may call. */
export interface HostServices {
  terminology?: TerminologyProvider | undefined
  resolver?: ReferenceResolver | undefined
}

/** fhirpath.js's `{ base, expression }` form: the FHIR type of a fragment passed as the input. */
export interface TypedPath {
  base: string
  expression: string
}

export type Path = string | TypedPath

export interface SmartFormsFhirpath {
  evaluate(
    fhirData: unknown,
    path: Path,
    envVars?: Record<string, unknown>,
    model?: unknown,
    options?: EvaluateOptions
  ): unknown[] | Promise<unknown[]>
}

/** What the host has for the service URLs of one call; Medplum ignores the URLs and uses its client. */
export type ServicesFor = (options: EvaluateOptions) => HostServices

function hasCall(node: AstNode, name: string): boolean {
  switch (node.kind) {
    case 'call':
      return node.name === name || node.args.some(arg => hasCall(arg, name))
    case 'dot':
    case 'binary':
      return hasCall(node.left, name) || hasCall(node.right, name)
    case 'indexer':
      return hasCall(node.target, name) || hasCall(node.index, name)
    case 'unary':
    case 'typeOp':
      return hasCall(node.operand, name)
    default:
      return false
  }
}

/**
 * The adapter. `services` supplies the terminology provider and resolver of a
 * call from its options; the engine asks them only for what contained
 * resources and Bundle entries cannot answer.
 */
export function smartFormsFhirpath(services: ServicesFor): SmartFormsFhirpath {
  // Typed results this adapter returned. They are recognized by identity, never by shape.
  const typedResults = new WeakSet<object>()
  const isTyped = (value: unknown): value is TypedValue =>
    typeof value === 'object' && value !== null && typedResults.has(value)

  function input(fhirData: unknown, path: Path): unknown {
    if (isTyped(fhirData)) return fhirData
    if (Array.isArray(fhirData) && fhirData.length > 0 && fhirData.every(isTyped)) return fhirData
    // The host declares the fragment's type; it is unattached, so %resource comes from the environment.
    return typeof path === 'string' ? fhirData : r4.toTyped(fhirData, path.base as FhirTypeName)
  }

  /** Typed values in the environment keep their types through `vars`; plain JSON stays in `env`. */
  function environment(envVars: Record<string, unknown>): {
    env: Record<string, unknown>
    vars: Record<string, TypedValue[]>
  } {
    const env: Record<string, unknown> = {}
    const vars: Record<string, TypedValue[]> = {}
    for (const [name, value] of Object.entries(envVars)) {
      if (isTyped(value)) vars[name] = [value]
      else if (Array.isArray(value) && value.length > 0 && value.every(isTyped)) vars[name] = value
      else env[name] = value
    }
    return { env, vars }
  }

  function keep(values: TypedValue[]): TypedValue[] {
    for (const value of values) typedResults.add(value)
    return values
  }

  return {
    evaluate(fhirData, path, envVars = {}, _model, options = {}) {
      const text = typeof path === 'string' ? path : path.expression
      const compiled = compile(text)
      const context = input(fhirData, path)
      const { env, vars } = environment(envVars)
      const typed = options.resolveInternalTypes === false
      const sync = () =>
        typed
          ? keep(compiled.evaluateTyped(context, { model: r4Model, env, vars }))
          : compiled.evaluate(context, { model: r4Model, env, vars })
      const async = () => {
        const host = services(options)
        const asyncOptions = {
          model: r4Model,
          env,
          vars,
          ...(host.terminology && { terminology: host.terminology }),
          ...(host.resolver && { resolver: host.resolver }),
        }
        return typed
          ? compiled.evaluateTypedAsync(context, asyncOptions).then(keep)
          : compiled.evaluateAsync(context, asyncOptions)
      }
      if (options.async === 'always') return async()
      if (!options.async) return sync()
      // A synchronous evaluation returns empty for an external reference; only the async one resolves it.
      if (options.fhirServerUrl && hasCall(compiled.ast, 'resolve')) return async()
      try {
        return sync()
      } catch (error) {
        if (error instanceof FhirPathAsyncRequiredError) return async()
        throw error
      }
    },
  }
}

/** Services from fhirpath.js's URL options, each over plain fetch. */
export const fetchServices: ServicesFor = options => ({
  terminology: options.terminologyUrl ? medplumTerminology(fhirClient(options.terminologyUrl)) : undefined,
  resolver: options.fhirServerUrl ? medplumResolver(fhirClient(options.fhirServerUrl)) : undefined,
})

/** Services over one authenticated Medplum client, whatever URLs the call names. */
export const medplumServices = (client: MedplumClientLike): ServicesFor => {
  const services = { terminology: medplumTerminology(client), resolver: medplumResolver(client) }
  return () => services
}

/** The module a build alias from `fhirpath` points at: fhirpath.js's URL options over fetch. */
export const fhirpath = smartFormsFhirpath(fetchServices)
export const evaluate = fhirpath.evaluate
export default fhirpath
