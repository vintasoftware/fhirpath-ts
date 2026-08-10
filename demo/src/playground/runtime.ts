/** Runtime half of the playground sandbox, kept independent of Monaco so the editor samples can be tested in Node. */

export type OutputLevel = 'log' | 'warn' | 'error' | 'throw'

export interface OutputLine {
  level: OutputLevel
  text: string
}

export type SandboxModules = Readonly<Record<string, Readonly<Record<string, unknown>>>>

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

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Execute emitted CommonJS with the playground's module allowlist and captured console. */
export function executeJavaScript(js: string, modules: SandboxModules): OutputLine[] {
  const out: OutputLine[] = []
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
  const requireShim = (specifier: string): Readonly<Record<string, unknown>> => {
    const mod = modules[specifier]
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
