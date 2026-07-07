import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findExpressionSites } from './expression-sites.ts'

describe('expression site extraction', () => {
  it('finds tags and literal call arguments with positions', () => {
    const source = [
      "import { fhirpath, compile, evaluate } from 'fhirpath-ts'",
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

  it('finds expressions in the subject-first engine helpers', () => {
    const source = [
      "import { r4 } from 'fhirpath-ts/r4'",
      "const active = r4.test(patient, 'active')",
      "const adults = r4.filter(patients, 'birthDate <= @2008-01-01')",
      "const typed = r4.evaluateTyped('Patient.birthDate', patient)",
      "const one = r4.first('Patient.name.family', patient)",
      'const rows = r4.project(patients, {',
      "  family: 'name.family.first()',",
      "  given: { path: 'name.given', collection: true },",
      "  quoted: { 'path': 'telecom.value' },",
      '  dynamic: someVariable,',
      '  [computed]: `name.$' + '{part}`,',
      '})',
      'const result = r4.checkConstraints(patient, [',
      "  { key: 'pat-1', expression: 'contact.name.exists()', human: 'contact needs a name' },",
      "  { key: 'dyn-1', expression: dynamicExpression },",
      '])',
    ].join('\n')
    const sites = findExpressionSites(source, 'sample.ts')
    expect(sites.map(site => site.expression)).toEqual([
      'active',
      'birthDate <= @2008-01-01',
      'Patient.birthDate',
      'Patient.name.family',
      'name.family.first()',
      'name.given',
      'telecom.value',
      'contact.name.exists()',
    ])
    const projectSite = sites.find(site => site.expression === 'name.given')
    expect(projectSite?.line).toBe(8)
    const constraintSite = sites.find(site => site.expression === 'contact.name.exists()')
    expect(constraintSite?.line).toBe(14)
  })

  it('leaves non-literal helper arguments and non-object shapes alone', () => {
    const source = [
      'const a = r4.test(patient)', // no expression argument at all
      'const b = r4.filter(patients, criteriaVariable)',
      'const c = r4.project(patients, columnsVariable)',
      'const d = r4.checkConstraints(patient, constraintsVariable)',
      'const e = r4.checkConstraints(patient, [constraintVariable, null])',
      'const f = items.filter(item => item.active)',
      "const g = pattern.test('some input string')", // regex-style test: expression is arg 1, absent here
      'const h = r4.project(patients, { ...spreadColumns, shorthand })',
    ].join('\n')
    expect(findExpressionSites(source, 'sample.ts')).toEqual([])
  })

  it('reads through side-effect imports and deep member callees', () => {
    const source = [
      "import './register-polyfill'", // no bindings to record
      "const a = app.engines.r4.evaluate('Patient.active', input)",
      "const b = getEngine().evaluate('Patient.gender', input)", // no identifier at the callee root
    ].join('\n')
    expect(findExpressionSites(source, 'sample.ts').map(site => site.expression)).toEqual([
      'Patient.active',
      'Patient.gender',
    ])
  })

  it('skips call names imported from other modules', () => {
    const source = [
      "import { compile } from 'handlebars'",
      "import fhirpath from 'some-other-fhirpath'",
      "import _ from 'lodash'",
      "import { evaluate } from 'fhirpath-ts'",
      "const template = compile('not a [fhirpath] expression')",
      'const other = fhirpath`Patient.nope`',
      "const picked = _.filter(users, 'not a [fhirpath] expression')",
      "const checked = evaluate('Patient.active', input)",
    ].join('\n')
    expect(findExpressionSites(source, 'sample.ts').map(site => site.expression)).toEqual(['Patient.active'])
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
      [
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
    expect(failed.output).toContain('dirty.ts:1:')
    expect(failed.output).toContain('unknown-element')
    expect(failed.output).toContain('unknown-function')
    expect(failed.output).toContain('dirty.ts:3:')
    expect(failed.output).toContain('syntax')
    expect(failed.output).toContain('dirty.ts:4:')
    expect(failed.output).toContain('4 problem(s) found')
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
