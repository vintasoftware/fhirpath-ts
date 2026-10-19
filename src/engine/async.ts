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
  readonly requests: Map<string, () => Promise<unknown>>

  constructor(requests: Map<string, () => Promise<unknown>>) {
    this.requests = requests
  }

  /** Adds a later suspension's requests; false when `error` is a real failure. */
  absorb(error: unknown): boolean {
    if (!(error instanceof AsyncSuspension)) return false
    for (const [key, run] of error.requests) this.requests.set(key, run)
    return true
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

/*
 * Independent work keeps running after one part suspends, so a replay collects
 * the requests of every independent part and awaits them together, as
 * fhirpath.js starts them together. Callers pass parts whose evaluations do not
 * read each other's results, so an answer one part waits for cannot change what
 * another asks. A failure after a part suspended is set aside for that
 * suspension: the replay reaches it again, in order, with the answers in place.
 * Sync evaluation never suspends, so it pays only for the try.
 */

/** Runs `step` for each item, collecting the requests of every item that suspends. */
export function forEachCollecting<T>(items: readonly T[], step: (item: T, index: number) => void): void {
  let pending: AsyncSuspension | undefined
  for (let index = 0; index < items.length; index++) {
    try {
      step(items[index] as T, index)
    } catch (error) {
      if (pending === undefined) {
        if (!(error instanceof AsyncSuspension)) throw error
        pending = error
      } else if (!pending.absorb(error)) {
        break
      }
    }
  }
  if (pending !== undefined) throw pending
}

/**
 * What to throw after `error` stopped one part: a suspension also collects the
 * requests of the independent `rest`; anything else is thrown as is.
 */
export function alsoCollecting(error: unknown, rest: () => unknown): unknown {
  if (error instanceof AsyncSuspension) {
    try {
      rest()
    } catch (later) {
      error.absorb(later)
    }
  }
  return error
}

/**
 * The catch half of the protocol: run `attempt` until it completes without
 * suspending, awaiting each suspension's requests concurrently and caching
 * the answers in between. Every request settles before the next step, and a
 * rejection propagates in request order, so the reported failure does not
 * depend on which provider answers first. Each replay resolves at least one
 * request the cache did not have, so the loop terminates — a deterministic
 * attempt can only suspend finitely often.
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
      // async: a provider that throws instead of rejecting still settles in order.
      const answers = await Promise.allSettled(requests.map(async ([, run]) => run()))
      for (const [index, answer] of answers.entries()) {
        if (answer.status === 'rejected') throw answer.reason
        cache.set((requests[index] as [string, unknown])[0], answer.value)
      }
    }
  }
}
