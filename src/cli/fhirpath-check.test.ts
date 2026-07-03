import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findExpressionSites } from './expression-sites.ts'

describe('expression site extraction', () => {
  it('finds tags and literal call arguments with positions', () => {
    const source = [
      "import { fhirpath, compile, evaluate } from '@vinta-bb/fhirpath'",
      'const a = fhirpath`Patient.name.given`',
      "const b = compile('Patient.birthDate')",
      "const c = evaluate('Patient.active', input)",
      "const d = api.evaluate('Patient.telecom.value', input)",
      'const dynamic = compile(someVariable)',
      'const template = fhirpath`Patient.$' + '{part}`',
    ].join('\n')
    const sites = findExpressionSites(source, 'sample.ts')
    expect(sites.map(site => site.expression)).toEqual([
      'Patient.name.given',
      'Patient.birthDate',
      'Patient.active',
      'Patient.telecom.value',
    ])
    expect(sites[0]?.line).toBe(2)
    expect(sites[1]?.line).toBe(3)
  })
})

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

  it('passes clean files and fails files with bad expressions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fhirpath-check-'))
    const clean = join(directory, 'clean.ts')
    writeFileSync(clean, 'const q = fhirpath`Patient.name.given`\n')
    const dirty = join(directory, 'dirty.ts')
    writeFileSync(
      dirty,
      ['const bad = fhirpath`Patient.nope`', "const worse = compile('Patient.name.frobnicate()')", ''].join('\n')
    )

    const ok = run([clean])
    expect(ok.status).toBe(0)
    expect(ok.output).toContain('no problems found')

    const failed = run([clean, dirty])
    expect(failed.status).toBe(1)
    expect(failed.output).toContain('dirty.ts:1:')
    expect(failed.output).toContain('unknown-element')
    expect(failed.output).toContain('unknown-function')
    expect(failed.output).toContain('2 problem(s) found')
  })

  it('exits with usage when no files are given', () => {
    const result = run([])
    expect(result.status).toBe(2)
    expect(result.output).toContain('usage:')
  })
})

describe('extraction ignores computed callees', () => {
  it('skips calls whose callee has no name', () => {
    const sites = findExpressionSites("const x = arr[0]('Patient.name')", 'sample.ts')
    expect(sites).toEqual([])
  })
})
