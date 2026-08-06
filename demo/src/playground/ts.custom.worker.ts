/**
 * Monaco's TypeScript worker plus a FHIRPath side channel. The side-effect
 * import wires Monaco's own worker protocol unchanged AND exposes the bundled
 * compiler as `globalThis.ts` (ts.worker does that at module scope) — which is
 * what lets the playground extract expression sites with the real TypeScript
 * AST without bundling a second compiler or blocking the main thread.
 *
 * The two protocols share one worker without touching each other: Monaco's
 * messages carry a `vsWorker` field and its handler ignores anything without
 * one, while this channel answers only messages carrying `fhirpathSites`.
 */
import 'monaco-editor/esm/vs/language/typescript/ts.worker'

import { createSiteFinder, type TypeScriptApi } from 'fhirpath-ts/sites'

/** A sites request from the main thread (see requestSites in index.ts). */
interface SitesRequest {
  fhirpathSites: number
  text: string
}

const find = createSiteFinder((globalThis as unknown as { ts: TypeScriptApi }).ts)

self.addEventListener('message', event => {
  const data = event.data as Partial<SitesRequest> | null
  if (typeof data?.fhirpathSites !== 'number' || typeof data.text !== 'string') {
    return
  }
  self.postMessage({ fhirpathSites: data.fhirpathSites, sites: find(data.text, 'buffer.ts') })
})
