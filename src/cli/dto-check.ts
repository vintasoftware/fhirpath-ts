/**
 * Imports DTO modules, records the engines they create, and checks each exported
 * DTO with loaded runtime context. The default module pattern is `*.dto.ts`.
 * Importing runs module initialization; `--no-import` skips this pass.
 */
/* v8 ignore file -- covered end-to-end as a subprocess in fhirpath-check.test.ts, which is the only way to exercise a module loader and engine discovery in a fresh process */
import { glob } from 'node:fs/promises'
import { register } from 'node:module'
import { relative } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { AnalyzeOptions } from '../analyzer/analyze.ts'
import { type AnalyzedContext, analyzeDto, type DtoDiagnostic } from '../analyzer/analyze-dto.ts'
import { analyzerEnvironmentVariables, analyzerVariables } from '../analyzer/declarations.ts'
import { type DtoClass, isDtoClass } from '../api/dto.ts'
import { type FhirPathEngine, recordEngines } from '../api/engine.ts'

/** Where DTO classes live unless `--dtos` says otherwise. */
export const DEFAULT_DTO_GLOB = '**/*.dto.ts'

/**
 * A checker configuration problem, not an expression finding: the imported
 * modules constructed engines whose contexts cannot be merged.
 */
export class EngineMergeError extends Error {}

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
  /** Merged engine declarations that make ordinary source-site checks complete. */
  sourceOptions: AnalyzeOptions | undefined
}

/** Imports matching modules and checks their exported DTOs against recorded engines. */
export async function checkDtoModules(patterns: readonly string[], cwd: string): Promise<DtoCheckResult> {
  const recorded = recordEngines()
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
  const engines = recorded()
  assertSharedModel(engines)
  const findings = dtos.flatMap(({ file, dto, cls }) =>
    analyzeFor(cls, engines).map(finding => ({ ...finding, dto, file }))
  )
  return {
    findings,
    files,
    engines: engines.length,
    dtos: dtos.map(({ file, dto }) => ({ file, dto })),
    sourceOptions: engines.length === 0 ? undefined : optionsForSource(merged(engines)),
  }
}

/**
 * A DTO against the engine that registered it, or — when no engine claims it, as
 * for a row shape that is only ever projected — against everything the project's
 * engines make available. A DTO checked against one engine of several would
 * report calls that resolve perfectly well in the engine it actually runs on, and
 * "some engine in this project declares this" is the most that can be said
 * without being told which. Merging says exactly that, once, in engine order.
 */
function analyzeFor(dto: DtoClass, engines: readonly FhirPathEngine[]): DtoDiagnostic[] {
  const owner = engines.find(engine => engine.dtos.includes(dto))
  if (owner !== undefined) {
    return analyzeDto(dto, { engine: owner, reportUnchecked: true })
  }
  if (engines.length === 0) {
    return analyzeDto(dto, { reportUnchecked: true })
  }
  return analyzeDto(dto, { engine: merged(engines), reportUnchecked: true })
}

/**
 * Merged analysis (unregistered DTOs, `sourceOptions`) uses the first engine's
 * model for every declaration, so all engines must share one `ModelProvider`
 * instance — a declaration analyzed under another engine's type hierarchy would
 * produce wrong element, subtype, and Reference-target findings. Identity is
 * the only equivalence a `ModelProvider` offers, so two wrappers around the
 * same logical model are still rejected; check such projects in separate runs.
 */
function assertSharedModel(engines: readonly FhirPathEngine[]): void {
  const model = engines[0]?.defaults.model
  if (engines.some(engine => engine.defaults.model !== model)) {
    throw new EngineMergeError(
      'the imported modules constructed engines with different ModelProvider instances; ' +
        'source and unregistered-DTO analysis needs one shared model — check projects with different models in separate runs'
    )
  }
}

/**
 * Every engine's context as one: the union of their registered functions,
 * environment declarations, and vars. The first engine's `model` stands for
 * all of them — `assertSharedModel` has proven they all carry the same one.
 */
function merged(engines: readonly FhirPathEngine[]): AnalyzedContext {
  return {
    defaults: {
      ...engines[0]?.defaults,
      functions: Object.assign({}, ...engines.map(engine => engine.defaults.functions)),
      env: Object.assign({}, ...engines.map(engine => engine.defaults.env)),
      envTypes: Object.assign({}, ...engines.map(engine => engine.defaults.envTypes)),
      vars: Object.assign({}, ...engines.map(engine => engine.defaults.vars)),
      varTypes: Object.assign({}, ...engines.map(engine => engine.defaults.varTypes)),
    },
  }
}

/** Turn merged engine runtime defaults into the declarations accepted by analyzeSite(). */
function optionsForSource(engine: AnalyzedContext): AnalyzeOptions {
  const { model, functions, env, envTypes, vars, varTypes } = engine.defaults
  return {
    ...(model !== undefined && { model }),
    ...(functions !== undefined && { functions }),
    variables: {
      ...analyzerEnvironmentVariables(env, envTypes, model),
      ...analyzerVariables(vars, varTypes),
    },
  }
}
