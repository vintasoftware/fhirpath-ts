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

/**
 * The adapter. `services` supplies the terminology provider and resolver of an
 * asynchronous call from its options; the engine asks them only for what
 * contained resources and Bundle entries cannot answer.
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

  function keep(values: TypedValue[]): TypedValue[] {
    for (const value of values) typedResults.add(value)
    return values
  }

  return {
    evaluate(fhirData, path, envVars = {}, _model, options = {}) {
      const compiled = parse(typeof path === 'string' ? path : path.expression)
      const context = input(fhirData, path)
      // Typed values in envVars bind as they are, as fhirpath.js's values with `__path__` do.
      const base = { model: r4Model, env: envVars }
      const typed = options.resolveInternalTypes === false
      if (!options.async) return typed ? keep(compiled.evaluateTyped(context, base)) : compiled.evaluate(context, base)
      const { terminology, resolver } = services(options)
      const asyncOptions = {
        ...base,
        ...(terminology && { terminology }),
        ...(resolver && { resolver }),
        // `async: true` returns a Promise only when a service answers part of the evaluation.
        syncWhenPossible: options.async !== 'always',
      }
      if (!typed) return compiled.evaluateAsync(context, asyncOptions)
      const results = compiled.evaluateTypedAsync(context, asyncOptions)
      return results instanceof Promise ? results.then(keep) : keep(results)
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
