import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('fhirpath-check CLI', () => {
  const cli = resolve(import.meta.dirname, 'fhirpath-check.ts')

  function run(args: string[], cwd?: string): { status: number; output: string } {
    // The file half needs no imports; every test that only checks literals passes
    // --no-import so a stray *.dto.ts in the working directory cannot affect it.
    const result = spawnSync(process.execPath, [cli, ...args], {
      encoding: 'utf8',
      ...(cwd !== undefined && { cwd }),
    })
    return { status: result.status ?? 0, output: `${result.stdout}${result.stderr}` }
  }

  it("resolves calls between a file's own DTO columns, and flags a near-miss", () => {
    const directory = mkdtempSync(join(tmpdir(), 'fhirpath-check-dto-'))
    const dto = (call: string): string =>
      [
        "import { column, defineDto } from 'fhirpath-ts'",
        "class ConceptDto extends defineDto('CodeableConcept') {",
        "  @column('(text | coding.display.first()).first()', { type: 'string' })",
        '  displayText!: string | undefined',
        '}',
        "class WeightRow extends defineDto('Observation') {",
        `  @column('${call}', { type: 'string', default: '' })`,
        '  name!: string',
        '}',
      ].join('\n')
    const good = join(directory, 'good.ts')
    writeFileSync(good, dto('code.displayText()'))
    expect(run(['--no-import', good]).status).toBe(0)
    const typo = join(directory, 'typo.ts')
    writeFileSync(typo, dto('code.displayTxt()'))
    const result = run(['--no-import', typo])
    expect(result.status).toBe(1)
    expect(result.output).toContain("Unrecognized function 'displayTxt' — did you mean 'displayText'?")
  })

  it('passes clean files and fails files with bad expressions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fhirpath-check-'))
    const clean = join(directory, 'clean.ts')
    writeFileSync(clean, 'const q = fhirpath`Patient.name.given`\n')
    const dirty = join(directory, 'dirty.ts')
    writeFileSync(
      dirty,
      [
        "import { r4 } from 'fhirpath-ts/r4'",
        'const bad = fhirpath`Patient.nope`',
        "const worse = compile('Patient.name.frobnicate()')",
        "const rows = r4.project(patients, { given: 'name..given' })",
        "const checked = r4.checkConstraints(patient, [{ key: 'x-1', expression: 'name.frobnicate()' }])",
        '',
      ].join('\n')
    )

    const ok = run(['--no-import', clean])
    expect(ok.status).toBe(0)
    expect(ok.output).toContain('no problems found')

    const failed = run(['--no-import', clean, dirty])
    expect(failed.status).toBe(1)
    expect(failed.output).toContain('dirty.ts:2:')
    expect(failed.output).toContain('unknown-element')
    expect(failed.output).toContain('unknown-function')
    expect(failed.output).toContain('dirty.ts:4:')
    expect(failed.output).toContain('syntax')
    expect(failed.output).toContain('dirty.ts:5:')
    expect(failed.output).toContain('4 problem(s) found')
  })

  it("discovers, imports and analyzes the project's *.dto.ts modules", () => {
    const directory = mkdtempSync(join(tmpdir(), 'fhirpath-check-project-'))
    // A package link, so the DTO module's `fhirpath-ts` import resolves the way
    // it would in a real project.
    mkdirSync(join(directory, 'node_modules'), { recursive: true })
    symlinkSync(resolve(import.meta.dirname, '../..'), join(directory, 'node_modules', 'fhirpath-ts'), 'dir')
    writeFileSync(
      join(directory, 'patient.dto.ts'),
      [
        "import { column, defineDto, FhirPathEngine } from 'fhirpath-ts'",
        "import { r4Model } from 'fhirpath-ts/r4'",
        '',
        "export class ConceptDto extends defineDto('CodeableConcept') {",
        "  @column('(text | coding.display.first()).first()', { type: 'string' })",
        '  displayText!: string | undefined',
        '}',
        '',
        '// Module-private on purpose: discovery records constructions, so an engine',
        '// does not have to be exported to be found.',
        'const fp = new FhirPathEngine({ model: r4Model, resourceDtos: [ConceptDto] })',
        '',
        "export class ProblemRow extends defineDto('Condition') {",
        '  // Resolves only through the engine above.',
        "  @column('code.displayText()', { type: 'string', default: '' })",
        '  name!: string',
        '',
        "  @column('clinicalStatus.coding.first().codee')",
        '  statusCode!: string | undefined',
        '}',
        '',
        'export const rows = (input: unknown[]): unknown => fp.project(input, ProblemRow)',
      ].join('\n')
    )
    const result = run([], directory)
    expect(result.status).toBe(1)
    // The valid cross-DTO call is silent; the typo is reported with a position
    // and the member it came from.
    expect(result.output).not.toContain('displayText')
    expect(result.output).toMatch(/patient\.dto\.ts:\d+:\d+ ProblemRow\.statusCode \[unknown-element\]/)
    expect(result.output).toContain('analyzed 2 DTO(s) from 1 module(s) against 1 engine(s)')
  })

  it('merges static declarations and vars from every engine for an unregistered DTO', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fhirpath-check-merged-context-'))
    mkdirSync(join(directory, 'node_modules'), { recursive: true })
    symlinkSync(resolve(import.meta.dirname, '../..'), join(directory, 'node_modules', 'fhirpath-ts'), 'dir')
    writeFileSync(
      join(directory, 'shared.dto.ts'),
      [
        "import { column, defineDto, FhirPathEngine } from 'fhirpath-ts'",
        "import { r4Model } from 'fhirpath-ts/r4'",
        '',
        "new FhirPathEngine({ model: r4Model, envTypes: { report: { type: 'DiagnosticReport' } } })",
        'new FhirPathEngine({',
        '  model: r4Model,',
        "  vars: { subject: '{}', loose: '{}' },",
        "  varTypes: { subject: { type: 'Patient' } },",
        '})',
        '',
        "export class SharedRow extends defineDto('Observation') {",
        "  @column('%report.status.first().length()', { type: 'integer' })",
        '  statusLength!: number | undefined',
        '',
        "  @column('%subject.name.given')",
        '  given!: string[]',
        '',
        "  @column('%loose')",
        '  loose!: unknown',
        '}',
      ].join('\n')
    )

    const result = run([], directory)
    expect(result.status).toBe(0)
    expect(result.output).toContain('analyzed 1 DTO(s) from 1 module(s) against 2 engine(s)')
  })

  it('reports a registered column called on a focus its own fhirType rules out', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fhirpath-check-input-'))
    mkdirSync(join(directory, 'node_modules'), { recursive: true })
    symlinkSync(resolve(import.meta.dirname, '../..'), join(directory, 'node_modules', 'fhirpath-ts'), 'dir')
    writeFileSync(
      join(directory, 'patient.dto.ts'),
      [
        "import { column, defineDto, FhirPathEngine } from 'fhirpath-ts'",
        "import { r4Model } from 'fhirpath-ts/r4'",
        '',
        "export class ConceptDto extends defineDto('CodeableConcept') {",
        "  @column('(text | coding.display.first()).first()', { type: 'string' })",
        '  displayText!: string | undefined',
        '}',
        '',
        'const fp = new FhirPathEngine({ model: r4Model, resourceDtos: [ConceptDto] })',
        '',
        "export class ProblemRow extends defineDto('Condition') {",
        '  // A CodeableConcept column, reached on a string.',
        "  @column('subject.reference.displayText()', { type: 'string', default: '' })",
        '  name!: string',
        '}',
        '',
        'export const rows = (input: unknown[]): unknown => fp.project(input, ProblemRow)',
      ].join('\n')
    )
    const result = run([], directory)
    expect(result.status).toBe(1)
    expect(result.output).toMatch(/patient\.dto\.ts:\d+:\d+ ProblemRow\.name \[input-type\]/)
    expect(result.output).toContain('displayText() expects FHIR.CodeableConcept as input, found FHIR.string')
  })

  it('says so when nothing matches, and skips the DTO half on --no-import', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fhirpath-check-empty-'))
    writeFileSync(join(directory, 'plain.ts'), 'const q = fhirpath`Patient.name.given`\n')
    const matched = run([], directory)
    expect(matched.status).toBe(0)
    expect(matched.output).toContain('no DTO modules matched **/*.dto.ts')
    const skipped = run(['--no-import', 'plain.ts'], directory)
    expect(skipped.status).toBe(0)
    expect(skipped.output).not.toContain('no DTO modules matched')
  })

  it('exits with usage when there is nothing to do', () => {
    const result = run(['--no-import'])
    expect(result.status).toBe(2)
    expect(result.output).toContain('usage:')
  })

  it('resolves an engine imported from another local module', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fhirpath-check-imported-engine-'))
    mkdirSync(join(directory, 'node_modules'), { recursive: true })
    symlinkSync(resolve(import.meta.dirname, '../..'), join(directory, 'node_modules', 'fhirpath-ts'), 'dir')
    writeFileSync(
      join(directory, 'engine.ts'),
      [
        "import { FhirPathEngine } from 'fhirpath-ts'",
        "import { r4Model } from 'fhirpath-ts/r4'",
        'export const fp = new FhirPathEngine({ model: r4Model })',
      ].join('\n')
    )
    writeFileSync(
      join(directory, 'shared.ts'),
      [
        "import { fp } from './engine.ts'",
        "const patient = { resourceType: 'Patient' as const }",
        "fp.compile('Patient.nam1')",
        "fp.evaluate('Patient.nam2', patient)",
        "fp.first('Patient.nam3', patient)",
        "fp.test(patient, 'Patient.nam4.exists()')",
        "fp.filter([patient], 'Patient.nam5.exists()')",
        "fp.project([patient], { x: 'Patient.nam6' })",
        "fp.evaluateTyped('Patient.nam7', patient)",
      ].join('\n')
    )

    const result = run(['--no-import', 'shared.ts'], directory)
    expect(result.status).toBe(1)
    expect(result.output.match(/\[unknown-element\]/g)).toHaveLength(7)
    expect(result.output).not.toContain('[warning:skipped]')
  })

  it('does not trust an unrelated type merely named FhirPathEngine', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fhirpath-check-foreign-engine-'))
    writeFileSync(
      join(directory, 'foreign.ts'),
      [
        'export class FhirPathEngine {',
        '  first(_expression: string, _input: unknown): unknown { return undefined }',
        '}',
        'export const fp = new FhirPathEngine()',
      ].join('\n')
    )
    writeFileSync(
      join(directory, 'source.ts'),
      ["import { fp } from './foreign.ts'", "fp.first('Patient.nam1', patient)"].join('\n')
    )

    const result = run(['--no-import', 'source.ts'], directory)
    expect(result.status).toBe(0)
    expect(result.output).toBe('fhirpath-check: no problems found\n')
  })

  it('uses imported engine environment for source sites', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fhirpath-check-source-env-'))
    mkdirSync(join(directory, 'node_modules'), { recursive: true })
    symlinkSync(resolve(import.meta.dirname, '../..'), join(directory, 'node_modules', 'fhirpath-ts'), 'dir')
    writeFileSync(
      join(directory, 'engine.ts'),
      [
        "import { FhirPathEngine } from 'fhirpath-ts'",
        "import { r4Model } from 'fhirpath-ts/r4'",
        'new FhirPathEngine({ model: r4Model, env: { known: 1 } })',
      ].join('\n')
    )
    writeFileSync(
      join(directory, 'source.ts'),
      ["import { fhirpath } from 'fhirpath-ts'", "fhirpath('%known = %misspelled', 'Patient')"].join('\n')
    )

    const result = run(['--dtos', 'engine.ts', 'source.ts'], directory)
    expect(result.status).toBe(1)
    expect(result.output).toContain('Undefined environment variable %misspelled')
    expect(result.output).not.toContain('Undefined environment variable %known')
  })

  it('associates project columns with inline env and vars without false unknown-variable errors', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fhirpath-check-project-vars-'))
    mkdirSync(join(directory, 'node_modules'), { recursive: true })
    symlinkSync(resolve(import.meta.dirname, '../..'), join(directory, 'node_modules', 'fhirpath-ts'), 'dir')
    writeFileSync(
      join(directory, 'recipe.ts'),
      [
        "import { FhirPathEngine } from 'fhirpath-ts'",
        "import { r4Model } from 'fhirpath-ts/r4'",
        'const r4 = new FhirPathEngine({ model: r4Model })',
        'r4.project(orders, {',
        "  resultDate: { path: '(%report.effective.ofType(dateTime) | %report.issued).first()', default: null },",
        "  hasResult: { test: '%report.exists()' },",
        '}, {',
        '  env: { reports },',
        "  vars: { report: '%reports.where(orderId = %context.id).report' },",
        '})',
      ].join('\n')
    )

    const result = run(['--no-import', 'recipe.ts'], directory)
    expect(result.status).toBe(0)
    expect(result.output).not.toContain('unknown-variable')
    expect(result.output).toContain('warning:unchecked-navigation')
  })

  it('checks var expressions on non-project EvaluateOptions calls', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fhirpath-check-evaluate-vars-'))
    mkdirSync(join(directory, 'node_modules'), { recursive: true })
    symlinkSync(resolve(import.meta.dirname, '../..'), join(directory, 'node_modules', 'fhirpath-ts'), 'dir')
    writeFileSync(
      join(directory, 'source.ts'),
      [
        "import { r4 } from 'fhirpath-ts/r4'",
        "const patient = { resourceType: 'Patient' as const }",
        "r4.evaluate('%v.exists()', patient, { vars: { v: 'Patient.nam1' } })",
      ].join('\n')
    )

    const result = run(['--no-import', 'source.ts'], directory)
    expect(result.status).toBe(1)
    expect(result.output).toContain("Element 'nam1' is not defined on FHIR.Patient")
    expect(result.output).not.toContain('[warning:skipped]')
  })

  it('reports variables hidden by computed env keys as unchecked, not unknown', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fhirpath-check-open-vars-'))
    writeFileSync(
      join(directory, 'source.ts'),
      [
        "import { r4 } from 'fhirpath-ts/r4'",
        "const patient = { resourceType: 'Patient' as const }",
        "r4.evaluate('%hidden.exists()', patient, { env: { [key]: 1 } })",
      ].join('\n')
    )

    const result = run(['--no-import', 'source.ts'], directory)
    expect(result.status).toBe(0)
    expect(result.output).toContain('warning:unchecked-variable')
    expect(result.output).toContain('%hidden')
    expect(result.output).not.toContain('unknown-variable')

    const strict = run(['--strict', '--no-import', 'source.ts'], directory)
    expect(strict.status).toBe(1)
    expect(strict.output).toContain('[unchecked-variable]')
  })

  it('does not trust declarations or var bodies that a spread may overwrite', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fhirpath-check-overwritten-options-'))
    writeFileSync(
      join(directory, 'source.ts'),
      [
        "import { r4 } from 'fhirpath-ts/r4'",
        "r4.evaluate('%x.status', patient, {",
        "  env: { x: observation }, envTypes: { x: { type: 'Patient' } }, ...unknownOptions,",
        '})',
        "r4.evaluate('%bad', patient, { vars: { bad: '%typo', ...{ bad: 'true' } } })",
      ].join('\n')
    )

    const result = run(['--no-import', 'source.ts'], directory)
    expect(result.status).toBe(0)
    expect(result.output).toContain('warning:unchecked-variable')
    expect(result.output).toContain('warning:skipped')
    expect(result.output).not.toContain('unknown-element')
    expect(result.output).not.toContain('%typo')
  })

  it('resolves tsconfig paths from the config file directory, not the working directory', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fhirpath-check-tsconfig-paths-'))
    mkdirSync(join(directory, 'node_modules'), { recursive: true })
    mkdirSync(join(directory, 'lib'))
    mkdirSync(join(directory, 'app'))
    symlinkSync(resolve(import.meta.dirname, '../..'), join(directory, 'node_modules', 'fhirpath-ts'), 'dir')
    writeFileSync(
      join(directory, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          allowImportingTsExtensions: true,
          noEmit: true,
          baseUrl: '.',
          paths: { '@app/*': ['./lib/*'] },
        },
      })
    )
    writeFileSync(
      join(directory, 'lib', 'engine.ts'),
      [
        "import { FhirPathEngine } from 'fhirpath-ts'",
        "import { r4Model } from 'fhirpath-ts/r4'",
        'export const fp = new FhirPathEngine({ model: r4Model })',
      ].join('\n')
    )
    writeFileSync(
      join(directory, 'app', 'shared.ts'),
      [
        "import { fp } from '@app/engine.ts'",
        "const patient = { resourceType: 'Patient' as const }",
        "fp.first('Patient.nam1', patient)",
      ].join('\n')
    )

    // The tsconfig sits in an ancestor of the working directory, so its paths
    // only resolve when parsed relative to its own directory.
    const result = run(['--no-import', 'shared.ts'], join(directory, 'app'))
    expect(result.status).toBe(1)
    expect(result.output).toContain("Element 'nam1' is not defined on FHIR.Patient")
    expect(result.output).not.toContain('[warning:skipped]')
  })

  it('keeps its resolution defaults under a partial tsconfig', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fhirpath-check-tsconfig-partial-'))
    mkdirSync(join(directory, 'node_modules'), { recursive: true })
    symlinkSync(resolve(import.meta.dirname, '../..'), join(directory, 'node_modules', 'fhirpath-ts'), 'dir')
    // A config declaring neither module nor moduleResolution must not discard
    // the NodeNext pair the checker needs to follow package exports.
    writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }))
    writeFileSync(
      join(directory, 'engine.ts'),
      [
        "import { FhirPathEngine } from 'fhirpath-ts'",
        "import { r4Model } from 'fhirpath-ts/r4'",
        'export const fp = new FhirPathEngine({ model: r4Model })',
      ].join('\n')
    )
    writeFileSync(
      join(directory, 'shared.ts'),
      [
        "import { fp } from './engine.ts'",
        "const patient = { resourceType: 'Patient' as const }",
        "fp.first('Patient.nam1', patient)",
      ].join('\n')
    )

    const result = run(['--no-import', 'shared.ts'], directory)
    expect(result.status).toBe(1)
    expect(result.output).toContain("Element 'nam1' is not defined on FHIR.Patient")
    expect(result.output).not.toContain('[warning:skipped]')
  })

  it('rejects engines constructed over different models as a configuration error', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fhirpath-check-mixed-models-'))
    mkdirSync(join(directory, 'node_modules'), { recursive: true })
    symlinkSync(resolve(import.meta.dirname, '../..'), join(directory, 'node_modules', 'fhirpath-ts'), 'dir')
    writeFileSync(
      join(directory, 'mixed.dto.ts'),
      [
        "import { FhirPathEngine } from 'fhirpath-ts'",
        "import { r4Model } from 'fhirpath-ts/r4'",
        'new FhirPathEngine({ model: r4Model })',
        'new FhirPathEngine({})',
      ].join('\n')
    )

    const result = run([], directory)
    expect(result.status).toBe(2)
    expect(result.output).toContain('different ModelProvider instances')
    expect(result.output).not.toContain('cannot import DTO modules')

    // Two wrappers around the same logical model have no provable equivalence.
    writeFileSync(
      join(directory, 'mixed.dto.ts'),
      [
        "import { FhirPathEngine } from 'fhirpath-ts'",
        "import { r4Model } from 'fhirpath-ts/r4'",
        'new FhirPathEngine({ model: r4Model })',
        'new FhirPathEngine({ model: { ...r4Model } })',
      ].join('\n')
    )
    expect(run([], directory).status).toBe(2)
  })

  it('reports skipped dynamic expressions and module-local DTOs, with strict opt-in failure', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fhirpath-check-coverage-'))
    mkdirSync(join(directory, 'node_modules'), { recursive: true })
    symlinkSync(resolve(import.meta.dirname, '../..'), join(directory, 'node_modules', 'fhirpath-ts'), 'dir')
    writeFileSync(
      join(directory, 'private.dto.ts'),
      [
        "import { column, defineDto } from 'fhirpath-ts'",
        "const keyedRow = (type: 'Condition') => defineDto(type)",
        "class ProblemRow extends keyedRow('Condition') {",
        "  @column('clinicalStatus.coding.first().code') status!: string | undefined",
        '}',
      ].join('\n')
    )
    writeFileSync(
      join(directory, 'dynamic.ts'),
      ["import { fhirpath } from 'fhirpath-ts'", "const expr = 'Patient.name'", "fhirpath(expr, 'Patient')"].join('\n')
    )

    const warned = run(['--dtos', 'private.dto.ts', 'dynamic.ts'], directory)
    expect(warned.status).toBe(0)
    expect(warned.output).toContain('[warning:skipped]')
    expect(warned.output).toContain('[warning:unloaded-dto]')
    expect(warned.output).toContain('2 warning(s), no errors found')

    const strict = run(['--strict', '--dtos', 'private.dto.ts', 'dynamic.ts'], directory)
    expect(strict.status).toBe(1)
    expect(strict.output).toContain('[skipped]')
    expect(strict.output).toContain('[unloaded-dto]')
  })
})
