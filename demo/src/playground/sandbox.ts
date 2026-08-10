/**
 * Runs the current playground buffer after Monaco compiles it to CommonJS. A
 * small `require` function provides the bundled package, and a local console
 * captures output. The static page has no server, credentials, or external data.
 */

import { column, criteria, defineDto, FhirPathEngine } from 'fhirpath-ts'
import { analyzeExpression } from 'fhirpath-ts/analyzer'
import { r4, r4Model } from 'fhirpath-ts/r4'

import { monaco } from './monaco.ts'

/** The only modules the sandbox can import: the real bundled engine and analyzer. */
const MODULES: Record<string, Record<string, unknown>> = {
  'fhirpath-ts': { column, criteria, defineDto, FhirPathEngine },
  'fhirpath-ts/r4': { r4, r4Model },
  'fhirpath-ts/analyzer': { analyzeExpression },
}

export type OutputLevel = 'log' | 'warn' | 'error' | 'throw'

export interface OutputLine {
  level: OutputLevel
  text: string
}

/** Render one `console` argument the way a devtools line would. */
function formatArg(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (value === undefined) {
    return 'undefined'
  }
  // JSON.stringify rejects bigint. Keep JavaScript's `5n` form for Long values.
  const json = JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? `${item}n` : item))
  return json ?? String(value)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Transpile `model` with Monaco's TypeScript worker and run it, capturing output. */
export async function runModel(model: monaco.editor.ITextModel): Promise<OutputLine[]> {
  const out: OutputLine[] = []
  let js: string
  try {
    const getWorker = await monaco.languages.typescript.getTypeScriptWorker()
    const client = await getWorker(model.uri)
    const emit = await client.getEmitOutput(model.uri.toString())
    js = emit.outputFiles.find(file => file.name.endsWith('.js'))?.text ?? ''
  } catch (error) {
    return [{ level: 'throw', text: `Could not compile: ${errorText(error)}` }]
  }

  const record =
    (level: OutputLevel) =>
    (...args: unknown[]) => {
      out.push({ level, text: args.map(formatArg).join(' ') })
    }
  const sandboxConsole = {
    log: record('log'),
    info: record('log'),
    warn: record('warn'),
    error: record('error'),
  }
  const requireShim = (specifier: string): Record<string, unknown> => {
    const mod = MODULES[specifier]
    if (!mod) {
      throw new Error(`Cannot import '${specifier}' in the playground`)
    }
    return mod
  }
  const moduleObj = { exports: {} as Record<string, unknown> }
  try {
    const run = new Function('require', 'exports', 'module', 'console', js)
    run(requireShim, moduleObj.exports, moduleObj, sandboxConsole)
  } catch (error) {
    out.push({ level: 'throw', text: errorText(error) })
  }
  if (out.length === 0) {
    out.push({ level: 'log', text: '(ran with no console output)' })
  }
  return out
}
