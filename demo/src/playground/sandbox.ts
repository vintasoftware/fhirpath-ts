/**
 * Runs the current playground buffer after Monaco compiles it to CommonJS. A
 * small `require` function provides the bundled package, and a local console
 * captures output. The static page has no server, credentials, or external data.
 */

import { column, criteria, defineDto, FhirPathEngine } from 'fhirpath-ts'
import { analyzeExpression } from 'fhirpath-ts/analyzer'
import { r4, r4Model } from 'fhirpath-ts/r4'

import { monaco } from './monaco.ts'
import { errorText, executeJavaScript, type OutputLine } from './runtime.ts'

/** The only modules the sandbox can import: the real bundled engine and analyzer. */
const MODULES: Record<string, Record<string, unknown>> = {
  'fhirpath-ts': { column, criteria, defineDto, FhirPathEngine },
  'fhirpath-ts/r4': { r4, r4Model },
  'fhirpath-ts/analyzer': { analyzeExpression },
}

export type { OutputLevel, OutputLine } from './runtime.ts'

/** Transpile `model` with Monaco's TypeScript worker and run it, capturing output. */
export async function runModel(model: monaco.editor.ITextModel): Promise<OutputLine[]> {
  let js: string
  try {
    const getWorker = await monaco.languages.typescript.getTypeScriptWorker()
    const client = await getWorker(model.uri)
    const emit = await client.getEmitOutput(model.uri.toString())
    js = emit.outputFiles.find(file => file.name.endsWith('.js'))?.text ?? ''
  } catch (error) {
    return [{ level: 'throw', text: `Could not compile: ${errorText(error)}` }]
  }

  return executeJavaScript(js, MODULES)
}
