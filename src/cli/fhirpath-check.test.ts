import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('fhirpath-check CLI', () => {
  const cli = resolve(import.meta.dirname, 'fhirpath-check.ts')

  function run(files: string[]): { status: number; output: string } {
    try {
      const stdout = execFileSync(process.execPath, [cli, ...files], { encoding: 'utf8', stdio: 'pipe' })
      return { status: 0, output: stdout }
    } catch (error) {
      const failure = error as { status: number; stdout: string; stderr: string }
      return { status: failure.status, output: `${failure.stdout}${failure.stderr}` }
    }
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
    expect(run([good]).status).toBe(0)
    const typo = join(directory, 'typo.ts')
    writeFileSync(typo, dto('code.displayTxt()'))
    const result = run([typo])
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

    const ok = run([clean])
    expect(ok.status).toBe(0)
    expect(ok.output).toContain('no problems found')

    const failed = run([clean, dirty])
    expect(failed.status).toBe(1)
    expect(failed.output).toContain('dirty.ts:2:')
    expect(failed.output).toContain('unknown-element')
    expect(failed.output).toContain('unknown-function')
    expect(failed.output).toContain('dirty.ts:4:')
    expect(failed.output).toContain('syntax')
    expect(failed.output).toContain('dirty.ts:5:')
    expect(failed.output).toContain('4 problem(s) found')
  })

  it('exits with usage when no files are given', () => {
    const result = run([])
    expect(result.status).toBe(2)
    expect(result.output).toContain('usage:')
  })
})
