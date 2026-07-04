import { describe, expect, it } from 'vitest'
import '../functions/install.ts'
import { functions } from '../functions/registry.ts'
import { FUNCTION_SIGNATURES } from './signatures.ts'

// Functions the analyzer deliberately has no signature for: they still get arity
// checks from the runtime registry, and their results stay unknown. Adding a
// runtime function without deciding its signature must be a conscious choice —
// extend either FUNCTION_SIGNATURES or this list.
const INTENTIONALLY_UNSIGNED = [
  'slice',
  'elementDefinition',
  'checkModifiers',
  'memberOf',
  'subsumes',
  'subsumedBy',
  'weight',
]

describe('analyzer signature table', () => {
  it('every signature refers to a registered runtime function', () => {
    const runtimeNames = new Set(functions.keys())
    const stale = Object.keys(FUNCTION_SIGNATURES).filter(name => !runtimeNames.has(name))
    expect(stale).toEqual([])
  })

  it('every runtime function either has a signature or is intentionally unsigned', () => {
    const missing = [...functions.keys()].filter(
      name => FUNCTION_SIGNATURES[name] === undefined && !INTENTIONALLY_UNSIGNED.includes(name)
    )
    expect(missing).toEqual([])
    // The allowlist itself must not go stale either.
    const pointless = INTENTIONALLY_UNSIGNED.filter(
      name => !functions.has(name) || FUNCTION_SIGNATURES[name] !== undefined
    )
    expect(pointless).toEqual([])
  })

  it('no signature declares more argument specs than the runtime accepts', () => {
    // The analyzer repeats the last arg spec for variadic positions, so a
    // signature never needs more specs than maxArity; declaring extra ones is
    // dead metadata and a sign the two halves of the contract have drifted.
    const overspecified = Object.entries(FUNCTION_SIGNATURES)
      .filter(([name, signature]) => {
        const runtime = functions.get(name)
        return runtime !== undefined && (signature.args?.length ?? 0) > runtime.maxArity
      })
      .map(([name]) => name)
    expect(overspecified).toEqual([])
  })
})
