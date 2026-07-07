import { FhirPathRuntimeError } from '../errors.ts'
import type { EvaluationContext } from './context.ts'

/**
 * Control-flow signal for the suspend-and-replay async strategy. The evaluator
 * stays synchronous: when a function needs a value only an async provider can
 * produce, it throws one of these; resolveSuspensions() below awaits `run()`,
 * caches the result under `key`, and re-runs the whole evaluation — which is
 * deterministic (fixed clock, cached async results), so each replay gets strictly
 * further. Deliberately not a FhirPathError: user code should never observe it.
 */
class AsyncSuspension {
  readonly key: string
  readonly run: () => Promise<unknown>

  constructor(key: string, run: () => Promise<unknown>) {
    this.key = key
    this.run = run
  }
}

/**
 * The resolved result for `key`, or a suspension that makes `evaluateAsync()`
 * produce it on the next replay. Under sync evaluation there is no replay loop,
 * so the request fails with a clear pointer to `evaluateAsync()`; `what` names
 * the calling feature for that message.
 */
export function requestAsync(
  context: EvaluationContext,
  what: string,
  key: string,
  run: () => Promise<unknown>
): unknown {
  const cache = context.asyncCache
  if (!cache) {
    throw new FhirPathRuntimeError(`${what} is only available with evaluateAsync()`)
  }
  if (!cache.has(key)) {
    throw new AsyncSuspension(key, run)
  }
  return cache.get(key)
}

/**
 * The catch half of the protocol: run `attempt` until it completes without
 * suspending, awaiting and caching each suspended request in between. Each
 * replay resolves one request the cache did not have, so the loop terminates —
 * a deterministic attempt can only suspend finitely often.
 */
export async function resolveSuspensions<T>(attempt: (asyncCache: Map<string, unknown>) => T): Promise<T> {
  const asyncCache = new Map<string, unknown>()
  for (;;) {
    try {
      return attempt(asyncCache)
    } catch (error) {
      if (!(error instanceof AsyncSuspension)) {
        throw error
      }
      asyncCache.set(error.key, await error.run())
    }
  }
}
