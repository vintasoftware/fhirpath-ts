/**
 * The fhirpath.js call shape Smart Forms uses, on fhirpath-ts. One module
 * holds every translation: argument order, the fixed R4 model, the explicit
 * fragment type of `{ base, expression }`, typed results carried between
 * calls, and the host services behind fhirpath.js's `async`, `terminologyUrl`,
 * and `fhirServerUrl` options. A build alias from `fhirpath` to this module
 * replaces the engine without touching the call sites; the Smart Forms edits
 * that remain are listed in docs/sdc-readiness.md.
 */
import { createCachedCompiler } from '../../src/api/compile.ts'
import {
  type AstNode,
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
    case 'instance':
      return node.elements.some(element => hasCall(element.value, name))
    case 'null':
    case 'boolean':
    case 'string':
    case 'number':
    case 'date':
    case 'dateTime':
    case 'time':
    case 'quantity':
    case 'identifier':
    case 'special':
    case 'external':
      return false
  }
}

/**
 * The adapter. `services` supplies the terminology provider and resolver of a
 * call from its options; the engine asks them only for what contained
 * resources and Bundle entries cannot answer.
 */
export function smartFormsFhirpath(services: ServicesFor): SmartFormsFhirpath {
  // The renderer evaluates the same expressions on every answer change.
  const parse = createCachedCompiler()
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
      const compiled = parse(typeof path === 'string' ? path : path.expression)
      const context = input(fhirData, path)
      const base = { model: r4Model, ...environment(envVars) }
      const typed = options.resolveInternalTypes === false
      const sync = () => (typed ? keep(compiled.evaluateTyped(context, base)) : compiled.evaluate(context, base))
      // The services are asked for only when the evaluation may use them.
      let host: HostServices | undefined
      const hostServices = () => (host ??= services(options))
      const async = () => {
        const { terminology, resolver } = hostServices()
        const asyncOptions = {
          ...base,
          ...(terminology && { terminology }),
          ...(resolver && { resolver }),
        }
        return typed
          ? compiled.evaluateTypedAsync(context, asyncOptions).then(keep)
          : compiled.evaluateAsync(context, asyncOptions)
      }
      if (options.async === 'always') return async()
      if (!options.async) return sync()
      // A synchronous evaluation returns empty for an external reference; only the async one resolves it.
      if (hasCall(compiled.ast, 'resolve') && hostServices().resolver) return async()
      try {
        return sync()
      } catch (error) {
        if (error instanceof FhirPathAsyncRequiredError) return async()
        throw error
      }
    },
  }
}

const TERMINOLOGY_OPERATIONS = ['expand', 'lookup', 'validateVS', 'validateCS', 'subsumes', 'translate'] as const

/**
 * A provider that answers each request once, as fhirpath.js's fetch cache
 * does. The renderer re-runs every calculated expression on each answer
 * change and awaits them in turn, so without it each change repeats the same
 * terminology requests. A failed request is not kept and is sent again.
 */
export function cachedTerminology(provider: TerminologyProvider): TerminologyProvider {
  const answers = new Map<string, Promise<unknown>>()
  const cached: TerminologyProvider = {}
  for (const name of TERMINOLOGY_OPERATIONS) {
    const operation = provider[name] as ((...args: unknown[]) => Promise<unknown>) | undefined
    if (operation === undefined) continue
    cached[name] = ((...args: unknown[]) => {
      const key = JSON.stringify([name, args])
      let answer = answers.get(key)
      if (answer === undefined) {
        answer = operation.apply(provider, args)
        answers.set(key, answer)
        answer.catch(() => answers.delete(key))
      }
      return answer
    }) as never
  }
  return cached
}

/** Services from fhirpath.js's URL options, each over plain fetch, one per URL so their caches last. */
export const fetchServices: ServicesFor = (() => {
  const terminologies = new Map<string, TerminologyProvider>()
  const resolvers = new Map<string, ReferenceResolver>()
  const memo = <T>(cache: Map<string, T>, url: string | undefined, build: (url: string) => T): T | undefined => {
    if (url === undefined) return undefined
    if (!cache.has(url)) cache.set(url, build(url))
    return cache.get(url)
  }
  return options => ({
    terminology: memo(terminologies, options.terminologyUrl, url =>
      cachedTerminology(medplumTerminology(fhirClient(url)))
    ),
    resolver: memo(resolvers, options.fhirServerUrl, url => medplumResolver(fhirClient(url))),
  })
})()

/**
 * Services over one authenticated Medplum client, whatever URLs the call names:
 * the host chose its server, and a URL from a form never redirects credentialed
 * requests.
 */
export const medplumServices = (client: MedplumClientLike): ServicesFor => {
  const services = { terminology: cachedTerminology(medplumTerminology(client)), resolver: medplumResolver(client) }
  return () => services
}

/** The module a build alias from `fhirpath` points at: fhirpath.js's URL options over fetch. */
export const fhirpath = smartFormsFhirpath(fetchServices)
export const evaluate = fhirpath.evaluate
export default fhirpath
