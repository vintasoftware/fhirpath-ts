/**
 * The `fhirpath-check` half that imports a project rather than reading it: DTO
 * modules are loaded, the engines they construct are discovered, and every DTO
 * is analyzed against the engine that projects it — the exhaustive check
 * `analyzeDto` performs, with the engine's real functions and env instead of the
 * hedges a source walker has to make (see analyzer/analyze.ts, `analyzeSite`).
 *
 * DTOs live in `*.dto.ts` by convention, so discovery needs no configuration;
 * `--dtos <glob>` overrides it. Importing runs module side effects, the same
 * bargain an ORM's schema command makes — `--no-import` skips this half entirely.
 */
/* v8 ignore file -- covered end-to-end as a subprocess in fhirpath-check.test.ts, which is the only way to exercise a module loader and engine discovery in a fresh process */
import { glob } from 'node:fs/promises'
import { register } from 'node:module'
import { relative } from 'node:path'
import { pathToFileURL } from 'node:url'

import { analyzeDto, type DtoDiagnostic } from '../analyzer/analyze-dto.ts'
import { type DtoClass, isDtoClass } from '../api/dto.ts'
import { type FhirPathEngine, recordedEngines, recordEngines } from '../api/engine.ts'

/** Where DTO classes live unless `--dtos` says otherwise. */
export const DEFAULT_DTO_GLOB = '**/*.dto.ts'

const IGNORED = ['**/node_modules/**', '**/dist/**', '**/build/**', '**/coverage/**']

/** One finding, with the DTO and file it belongs to and the expression that produced it. */
export interface DtoFinding extends DtoDiagnostic {
  /** The DTO class name. */
  dto: string
  /** The module the DTO was imported from, relative to the working directory. */
  file: string
}

export interface DtoCheckResult {
  findings: DtoFinding[]
  /** Modules that matched and were imported, relative to the working directory. */
  files: string[]
  /** How many engines the imported modules constructed. */
  engines: number
  /** Every DTO analyzed, by module. */
  dtos: { file: string; dto: string }[]
}

/**
 * Import the DTO modules matching `patterns`, then analyze every DTO they export
 * against the engines they built. An engine is usually module-private, so
 * discovery records constructions rather than scanning exports; a DTO must be
 * exported to be found, which is what makes the convention worth standardizing.
 */
export async function checkDtoModules(patterns: readonly string[], cwd: string): Promise<DtoCheckResult> {
  recordEngines()
  register(new URL('ts-loader.mjs', import.meta.url))
  const files: string[] = []
  const dtos: { file: string; dto: string; cls: DtoClass }[] = []
  for await (const match of glob(patterns.length > 0 ? [...patterns] : [DEFAULT_DTO_GLOB], { cwd, exclude: IGNORED })) {
    const file = relative(cwd, new URL(match, pathToFileURL(`${cwd}/`)).pathname)
    files.push(file)
    const module: Record<string, unknown> = await import(pathToFileURL(`${cwd}/${match}`).href)
    for (const [name, value] of Object.entries(module)) {
      if (isDtoClass(value)) {
        dtos.push({ file, dto: value.name || name, cls: value })
      }
    }
  }
  const engines = recordedEngines()
  const findings = dtos.flatMap(({ file, dto, cls }) =>
    analyzeFor(cls, engines).map(finding => ({ ...finding, dto, file }))
  )
  return { findings, files, engines: engines.length, dtos: dtos.map(({ file, dto }) => ({ file, dto })) }
}

/**
 * A DTO against the engine that registered it, or — when no engine claims it, as
 * for a row shape that is only ever projected — against whichever engine leaves
 * the fewest findings. A project may build several engines, and a DTO checked
 * against the wrong one would report calls that are perfectly resolvable in the
 * engine it actually runs on, so the quietest answer is the honest one.
 */
function analyzeFor(dto: DtoClass, engines: readonly FhirPathEngine[]): DtoDiagnostic[] {
  const owner = engines.find(engine => engine.dtos.includes(dto))
  if (owner !== undefined) {
    return analyzeDto(dto, { engine: owner })
  }
  if (engines.length === 0) {
    return analyzeDto(dto)
  }
  return engines
    .map(engine => analyzeDto(dto, { engine }))
    .reduce((fewest, findings) => (findings.length < fewest.length ? findings : fewest))
}
