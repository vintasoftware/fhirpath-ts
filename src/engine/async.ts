import { FhirPathRuntimeError } from '../errors.ts'
import type { EvaluationContext } from './context.ts'

/**
 * Control-flow signal for the suspend-and-replay async strategy. The evaluator
 * stays synchronous: when a function needs a value only an async provider can
 * produce, it throws one of these. `evaluateAsync()` catches it, awaits `run()`,
 * caches the result under `key`, and re-runs the whole evaluation — which is
 * deterministic (fixed clock, cached async results), so each replay gets strictly
 * further. Deliberately not a FhirPathError: user code should never observe it.
 */
export class AsyncSuspension {
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
