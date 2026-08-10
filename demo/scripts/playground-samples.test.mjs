import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import ts from 'typescript'

import { analyzeExpression, analyzeSite } from '../../src/analyzer/index.ts'
import { column, criteria, defineDto, FhirPathEngine } from '../../src/index.ts'
import { r4, r4Model } from '../../src/r4/index.ts'
import { createSiteFinder } from '../../src/sites/index.ts'
import { executeJavaScript } from '../src/playground/runtime.ts'
import { SAMPLES } from '../src/playground/samples.ts'

const DECLARATIONS = new Map([
  [
    '/node_modules/fhirpath-ts/index.d.ts',
    readFileSync(new URL('../src/monaco/fhirpath-ts.index.d.ts', import.meta.url), 'utf8'),
  ],
  [
    '/node_modules/fhirpath-ts/r4/index.d.ts',
    readFileSync(new URL('../src/monaco/fhirpath-ts.r4.d.ts', import.meta.url), 'utf8'),
  ],
  [
    '/node_modules/fhirpath-ts/analyzer/index.d.ts',
    readFileSync(new URL('../src/monaco/fhirpath-ts.analyzer.d.ts', import.meta.url), 'utf8'),
  ],
])

const COMPILER_OPTIONS = {
  target: ts.ScriptTarget.ES2020,
  useDefineForClassFields: true,
  module: ts.ModuleKind.CommonJS,
  moduleResolution: ts.ModuleResolutionKind.NodeJs,
  strict: true,
  noEmit: false,
  esModuleInterop: true,
  allowNonTsExtensions: true,
  skipLibCheck: true,
  lib: ['lib.esnext.d.ts', 'lib.dom.d.ts'],
}

const PROJECT_ROW_VARIABLES = {
  rowIndex: { types: ['System.Integer'], single: true },
  rowTotal: { types: ['System.Integer'], single: true },
}

const MODULES = {
  'fhirpath-ts': { column, criteria, defineDto, FhirPathEngine },
  'fhirpath-ts/r4': { r4, r4Model },
  'fhirpath-ts/analyzer': { analyzeExpression },
}

const normalize = path => path.replaceAll('\\', '/')

function sampleProgram() {
  const files = new Map([...DECLARATIONS, ...SAMPLES.map(sample => [`/${sample.id}.ts`, sample.code])])
  const base = ts.createCompilerHost(COMPILER_OPTIONS)
  const host = {
    ...base,
    getCurrentDirectory: () => '/',
    fileExists: path => files.has(normalize(path)) || base.fileExists(path),
    readFile: path => files.get(normalize(path)) ?? base.readFile(path),
    directoryExists(path) {
      const directory = `${normalize(path).replace(/\/$/, '')}/`
      return [...files.keys()].some(file => file.startsWith(directory)) || base.directoryExists?.(path) === true
    },
    getDirectories(path) {
      const directory = `${normalize(path).replace(/\/$/, '')}/`
      const virtual = [...files.keys()]
        .filter(file => file.startsWith(directory))
        .map(file => file.slice(directory.length).split('/')[0])
        .filter(Boolean)
      return [...new Set([...(base.getDirectories?.(path) ?? []), ...virtual])]
    },
    getSourceFile(path, languageVersion) {
      const source = this.readFile(path)
      return source === undefined ? undefined : ts.createSourceFile(path, source, languageVersion, true)
    },
  }
  return ts.createProgram({
    rootNames: SAMPLES.map(sample => `/${sample.id}.ts`),
    options: COMPILER_OPTIONS,
    host,
  })
}

const diagnosticText = diagnostic => {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
  if (!diagnostic.file || diagnostic.start === undefined) {
    return `TS${diagnostic.code}: ${message}`
  }
  const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
  return `${diagnostic.file.fileName}:${line + 1}:${character + 1} TS${diagnostic.code}: ${message}`
}

test('runnable editor samples type-check, analyze, and run', () => {
  const program = sampleProgram()
  const findExpressionSites = createSiteFinder(ts)

  for (const sample of SAMPLES.filter(sample => sample.runnable)) {
    const source = program.getSourceFile(`/${sample.id}.ts`)
    assert.ok(source, `TypeScript did not load the ${sample.id} editor buffer`)

    const diagnostics = ts.getPreEmitDiagnostics(program, source).map(diagnosticText)
    assert.deepEqual(diagnostics, [], `${sample.id} has unexpected TypeScript diagnostics:\n${diagnostics.join('\n')}`)

    const sites = findExpressionSites(sample.code, `${sample.id}.ts`)
    assert.ok(sites.length > 0, `${sample.id} does not expose any FHIRPath expressions`)
    const analyzerDiagnostics = sites.flatMap(site =>
      analyzeSite(site, { model: r4Model, variables: PROJECT_ROW_VARIABLES }).map(
        diagnostic => `${site.expression}: [${diagnostic.code}] ${diagnostic.message}`
      )
    )
    assert.deepEqual(
      analyzerDiagnostics,
      [],
      `${sample.id} has unexpected FHIRPath diagnostics:\n${analyzerDiagnostics.join('\n')}`
    )

    let js
    const emit = program.emit(source, (name, text) => {
      if (name.endsWith('.js')) {
        js = text
      }
    })
    assert.equal(emit.emitSkipped, false, `${sample.id} could not be emitted`)
    assert.equal(typeof js, 'string', `${sample.id} did not emit JavaScript`)

    const outputs = executeJavaScript(js, MODULES)
    const throws = outputs.filter(output => output.level === 'throw')
    assert.deepEqual(throws, [], `${sample.id} threw while running:\n${throws.map(output => output.text).join('\n')}`)
  }
})
