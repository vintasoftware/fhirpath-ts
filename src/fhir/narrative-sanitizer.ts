import type { NarrativeSanitizer } from '../engine/context.ts'
import { ALLOWED_ATTRIBUTES } from './html-checks.ts'

/** The parts of a DOMPurify instance the adapter uses. */
export interface DomPurifyLike {
  sanitize(dirty: string, config: Record<string, unknown>): unknown
  /** What the last sanitize() call removed; DOMPurify resets it on each call. */
  readonly removed: readonly unknown[]
}

/**
 * DOMPurify removes comments and some inert attributes the FHIR rules allow, so
 * the default keeps every attribute the narrative allowlist accepts, and
 * comments. DOMPurify still checks URL values and rejects comments that hold
 * markup.
 */
const DEFAULT_CONFIG: Readonly<Record<string, unknown>> = {
  ADD_ATTR: [...ALLOWED_ATTRIBUTES],
  ADD_TAGS: ['#comment'],
}

/**
 * Adapts DOMPurify (https://github.com/cure53/DOMPurify) for the
 * `narrativeSanitizer` option: a narrative passes when DOMPurify removes
 * nothing from it. Settings in `config` override the default ones; for
 * example, set `ALLOWED_URI_REGEXP` to keep `urn:` links, which DOMPurify
 * removes.
 */
export function domPurifySanitizer(
  purify: DomPurifyLike,
  config: Readonly<Record<string, unknown>> = {}
): NarrativeSanitizer {
  const settings = { ...DEFAULT_CONFIG, ...config }
  return {
    accepts: xhtml => {
      purify.sanitize(xhtml, settings)
      return purify.removed.length === 0
    },
  }
}
