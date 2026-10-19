import type { TerminologyProvider } from '../terminology/provider.ts'

/**
 * What only `evaluateAsync()` gives an evaluation: the per-evaluation answer
 * cache and the host services that fill it. A sync evaluation has none, so a
 * function that needs a service reports that from one check.
 */
export interface AsyncServices {
  readonly cache: Map<string, unknown>
  readonly terminology: TerminologyProvider | undefined
}

type Requests = ReadonlyMap<string, () => Promise<unknown>>

/**
 * Control-flow signal for the suspend-and-replay async strategy. The evaluator
 * stays synchronous: when a function needs a value only an async provider can
 * produce, it throws one of these; resolveSuspensions() below awaits every
 * request it carries, caches the results by key, and re-runs the whole
 * evaluation — which is deterministic (fixed clock, cached async results), so
 * each replay gets strictly further. Deliberately not a FhirPathError: user code
 * should never observe it.
 */
class AsyncSuspension {
  readonly requests: Requests

  constructor(requests: Requests) {
    this.requests = requests
  }
}

/**
 * The resolved result for `key`, or a suspension that makes `evaluateAsync()`
 * produce it on the next replay.
 */
export function requestAsync(services: AsyncServices, key: string, run: () => Promise<unknown>): unknown {
  if (!services.cache.has(key)) {
    throw new AsyncSuspension(new Map([[key, run]]))
  }
  return services.cache.get(key)
}

/**
 * Runs `step` for each item without letting one item's suspension stop the
 * others, so a replay collects the requests of every independent item and
 * awaits them together, as fhirpath.js starts them together. Callers pass items
 * whose evaluations do not read each other's results, so an answer one item
 * waits for cannot change what another asks. A failure after an item suspended
 * is set aside for that suspension: the replay reaches it again, in order, with
 * the answers in place.
 */
export function forEachCollecting<T>(items: readonly T[], step: (item: T, index: number) => void): void {
  let pending: Map<string, () => Promise<unknown>> | undefined
  for (let index = 0; index < items.length; index++) {
    try {
      step(items[index] as T, index)
    } catch (error) {
      if (!(error instanceof AsyncSuspension)) {
        if (pending === undefined) throw error
        break
      }
      pending ??= new Map()
      for (const [key, run] of error.requests) pending.set(key, run)
    }
  }
  if (pending !== undefined) throw new AsyncSuspension(pending)
}

/**
 * The catch half of the protocol: run `attempt` until it completes without
 * suspending, awaiting each suspension's requests concurrently and caching
 * them in between. Each replay resolves at least one request the cache did not
 * have, so the loop terminates — a deterministic attempt can only suspend
 * finitely often.
 */
export async function resolveSuspensions<T>(attempt: (cache: Map<string, unknown>) => T): Promise<T> {
  const cache = new Map<string, unknown>()
  for (;;) {
    try {
      return attempt(cache)
    } catch (error) {
      if (!(error instanceof AsyncSuspension)) {
        throw error
      }
      const requests = [...error.requests]
      const answers = await Promise.all(requests.map(([, run]) => run()))
      requests.forEach(([key], index) => cache.set(key, answers[index]))
    }
  }
}
