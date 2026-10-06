import type { NarrativeSanitizer } from '../engine/context.ts'

/** The parts of a DOMPurify instance the adapter uses. */
export interface DomPurifyLike {
  sanitize(dirty: string, config: Record<string, unknown>): unknown
  /** What the last sanitize() call removed; DOMPurify resets it on each call. */
  readonly removed: readonly unknown[]
}

/**
 * FHIR narratives may carry these XML attributes, which DOMPurify removes by
 * default although they are inert.
 */
const DEFAULT_CONFIG: Readonly<Record<string, unknown>> = { ADD_ATTR: ['xml:lang', 'xml:space', 'xml:id'] }

/**
 * Adapts DOMPurify (https://github.com/cure53/DOMPurify) for the
 * `narrativeSanitizer` option: a narrative passes when DOMPurify removes
 * nothing from it. `config` replaces the default DOMPurify config; for example,
 * set `ALLOWED_URI_REGEXP` to keep `urn:` links, which DOMPurify removes.
 */
export function domPurifySanitizer(
  purify: DomPurifyLike,
  config: Readonly<Record<string, unknown>> = DEFAULT_CONFIG
): NarrativeSanitizer {
  return {
    accepts: xhtml => {
      purify.sanitize(xhtml, { ...config })
      return purify.removed.length === 0
    },
  }
}
