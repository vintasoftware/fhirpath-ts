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
})
