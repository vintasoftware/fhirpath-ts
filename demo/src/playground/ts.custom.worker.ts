/**
 * Adds a FHIRPath message channel to Monaco's TypeScript worker. Monaco exposes
 * its compiler as `globalThis.ts`, so the channel can find expression sites
 * without another compiler bundle. Monaco handles `vsWorker` messages; this
 * channel handles only `fhirpathSites` messages.
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
