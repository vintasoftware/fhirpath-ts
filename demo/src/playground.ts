/**
 * The "Edit it — checked live" playground. A Monaco editor whose built-in
 * TypeScript worker type-checks the code against fhirpath-ts's real declarations
 * (bundled into src/monaco/*.d.ts), so the inferred result types and the input
 * mismatches surface exactly as they would in your editor. On top of that we run
 * the §11 analyzer over the FHIRPath literals the code contains — the same check
 * the fhirpath-check CLI and the ESLint rule run.
 *
 * Runnable tabs also execute: Monaco transpiles the buffer to JS, which we run in
 * a `new Function` sandbox with a `require` shim that hands back the real bundled
 * engine and a captured `console`. It is the user's own code, running in their own
 * browser against synthetic data — nothing leaves the page.
 */

import { analyzeExpression } from 'fhirpath-ts/analyzer'
import { r4, r4Model } from 'fhirpath-ts/r4'
import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import analyzerDts from './monaco/fhirpath-ts.analyzer.d.ts?raw'
import r4Dts from './monaco/fhirpath-ts.r4.d.ts?raw'

interface MonacoEnvironmentShape {
  getWorker(id: string, label: string): Worker
}
;(self as unknown as { MonacoEnvironment: MonacoEnvironmentShape }).MonacoEnvironment = {
  getWorker(_id, label) {
    return label === 'typescript' || label === 'javascript' ? new tsWorker() : new editorWorker()
  },
}

interface Sample {
  id: string
  label: string
  /** Runnable samples get a Run button; the analyze tab is a static error showcase. */
  runnable: boolean
  code: string
}

const SAMPLES: Sample[] = [
  {
    id: 'analyze',
    label: 'analyze',
    runnable: false,
    code: `import { r4 } from 'fhirpath-ts/r4'
import { analyzeExpression } from 'fhirpath-ts/analyzer'

const patient = {
  resourceType: 'Patient' as const,
  name: [{ family: 'Okoro', given: ['Adaeze', 'Ngozi'] }],
  birthDate: '1984-11-02',
}

// Result types are inferred from the expression literal — hover to see them:
const given = r4.evaluate('Patient.name.given', patient)   // string[]
const family = r4.first('Patient.name.family', patient)    // string | undefined

// Type error: Patient.name is HumanName[], not string[] — the misassignment is caught.
const names: string[] = r4.evaluate('Patient.name', patient)

// Type error: this path expects a Patient, but here it's handed an Observation.
const weight = { resourceType: 'Observation' as const, status: 'final' }
r4.evaluate('Patient.name.given', weight)

// Analyzer (the fhirpath-check CLI / ESLint rule): 'namee' is not on Patient.
r4.evaluate('Patient.namee.given', patient)

// The analyzer is callable directly, too:
analyzeExpression('Observation.valueQuantity', { inputType: 'Observation' })
`,
  },
  {
    id: 'evaluate',
    label: 'evaluate',
    runnable: true,
    code: `import { r4 } from 'fhirpath-ts/r4'

const patient = {
  resourceType: 'Patient' as const,
  name: [{ family: 'Okoro', given: ['Adaeze', 'Ngozi'] }],
  telecom: [{ system: 'phone', value: '+1-555-0142' }],
  birthDate: '1984-11-02',
}

// Result types are inferred from the expression literal — and these actually run.
// Hover a call to see its type, then press Run to see the value.
console.log(r4.evaluate('Patient.name.given', patient))                    // string[]
console.log(r4.first('Patient.name.family', patient))                      // string | undefined
console.log(r4.evaluate("Patient.telecom.where(system = 'phone').value", patient))  // string[]
console.log(r4.first('Patient.name.given.count()', patient))               // number | undefined
`,
  },
  {
    id: 'filter',
    label: 'filter',
    runnable: true,
    code: `import { r4 } from 'fhirpath-ts/r4'

// A searchset of resources. filter() keeps the ones whose criteria hold, and
// preserves the element type — 'adults' is Patient[], not unknown[].
const patients = [
  { resourceType: 'Patient' as const, id: 'p1', birthDate: '1984-11-02', active: true },
  { resourceType: 'Patient' as const, id: 'p2', birthDate: '1991-06-15', active: false },
]

const adults = r4.filter(patients, 'birthDate < @1990-01-01')
console.log('matched:', adults.map(p => p.id))

// test() reduces a boolean criteria (the enableWhen / invariant semantics):
console.log('p1 active:', r4.test(patients[0], 'active = true'))
`,
  },
  {
    id: 'project',
    label: 'project',
    runnable: true,
    code: `import { r4 } from 'fhirpath-ts/r4'

const patients = [
  { resourceType: 'Patient' as const, id: 'p1', name: [{ family: 'Okoro', given: ['Adaeze'] }] },
  { resourceType: 'Patient' as const, id: 'p2', name: [{ family: 'Chen', given: ['Wei', 'Lin'] }] },
]

// project() builds a typed row per resource, one column per FHIRPath expression.
const rows = r4.project(patients, {
  id: 'Patient.id',
  name: "(Patient.name.family + ' ' + Patient.name.given.join(' ')).trim()",
})

console.log(rows)
`,
  },
  {
    id: 'checkConstraints',
    label: 'checkConstraints',
    runnable: true,
    code: `import { r4 } from 'fhirpath-ts/r4'

// A patient with a birthDate in the future — pat-2 should fail.
const patient = { resourceType: 'Patient' as const, gender: 'female', birthDate: '2100-01-01' }

// FHIR invariants as FHIRPath — checkConstraints() runs them and reports failures.
const result = r4.checkConstraints(patient, [
  { key: 'pat-1', human: 'gender must be present', expression: 'gender.exists()' },
  { key: 'pat-2', human: 'born in the past', expression: 'birthDate < today()' },
])

console.log('valid:', result.valid)   // boolean
console.log(result.issues)            // the failing constraints, in order
`,
  },
]

/** Function names whose first string argument is a FHIRPath expression (mirrors CALL_NAMES). */
const CALL_NAMES = new Set(['fhirpath', 'compile', 'evaluate', 'analyzeExpression'])
const TAG_NAME = 'fhirpath'

interface Site {
  expression: string
  /** 0-based offset of the expression's first character in the source. */
  contentStart: number
}

type Token =
  | { type: 'id'; value: string; start: number }
  | { type: 'str'; value: string; start: number; contentStart: number }
  | { type: 'tmpl'; value: string | null; start: number; contentStart: number }
  | { type: 'punct'; value: string; start: number }

const isIdentStart = (c: string) => /[A-Za-z_$]/.test(c)
const isIdentPart = (c: string) => /[\w$]/.test(c)

/** Lex just enough to find call/tag sites, skipping comments so they never match. */
function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++
    } else if (c === '/' && src[i + 1] === '/') {
      i += 2
      while (i < src.length && src[i] !== '\n') {
        i++
      }
    } else if (c === '/' && src[i + 1] === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        i++
      }
      i += 2
    } else if (c === "'" || c === '"') {
      const start = i
      i++
      let value = ''
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') {
          value += src[i + 1] ?? ''
          i += 2
        } else {
          value += src[i]
          i++
        }
      }
      i++
      tokens.push({ type: 'str', value, start, contentStart: start + 1 })
    } else if (c === '`') {
      const start = i
      i++
      let value = ''
      let dynamic = false
      while (i < src.length && src[i] !== '`') {
        if (src[i] === '\\') {
          value += src[i + 1] ?? ''
          i += 2
        } else {
          if (src[i] === '$' && src[i + 1] === '{') {
            dynamic = true
          }
          value += src[i]
          i++
        }
      }
      i++
      tokens.push({ type: 'tmpl', value: dynamic ? null : value, start, contentStart: start + 1 })
    } else if (isIdentStart(c)) {
      const start = i
      while (i < src.length && isIdentPart(src[i]!)) {
        i++
      }
      tokens.push({ type: 'id', value: src.slice(start, i), start })
    } else {
      tokens.push({ type: 'punct', value: c, start: i })
      i++
    }
  }
  return tokens
}

/** Find the FHIRPath expression literals in the source: `fhirpath` tags and the known calls. */
function scanExpressions(src: string): Site[] {
  const tokens = tokenize(src)
  const sites: Site[] = []
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k]!
    if (token.type !== 'id') {
      continue
    }
    const next = tokens[k + 1]
    if (token.value === TAG_NAME && next?.type === 'tmpl' && next.value !== null) {
      sites.push({ expression: next.value, contentStart: next.contentStart })
    } else if (CALL_NAMES.has(token.value) && next?.type === 'punct' && next.value === '(') {
      const arg = tokens[k + 2]
      if (arg?.type === 'str') {
        sites.push({ expression: arg.value, contentStart: arg.contentStart })
      }
    }
  }
  return sites
}

let configured = false

function configureTypeScript(): void {
  if (configured) {
    return
  }
  configured = true
  const ts = monaco.languages.typescript
  ts.typescriptDefaults.setCompilerOptions({
    target: ts.ScriptTarget.ESNext,
    // CommonJS so the transpiled buffer runs in a `new Function` sandbox (imports
    // become `require(...)` calls we can intercept); inference is unaffected.
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    strict: true,
    noEmit: false,
    esModuleInterop: true,
    allowNonTsExtensions: true,
    skipLibCheck: true,
    lib: ['esnext', 'dom'],
  })
  // Placed under node_modules so `import ... from 'fhirpath-ts/r4'` resolves the
  // way it would in a real project.
  ts.typescriptDefaults.addExtraLib(r4Dts, 'file:///node_modules/fhirpath-ts/r4/index.d.ts')
  ts.typescriptDefaults.addExtraLib(analyzerDts, 'file:///node_modules/fhirpath-ts/analyzer/index.d.ts')

  monaco.editor.defineTheme('fhirpath-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'string', foreground: '19c37d' },
      { token: 'keyword', foreground: '7aa2f7' },
      { token: 'comment', foreground: '7c8d85', fontStyle: 'italic' },
      { token: 'number', foreground: 'e0972b' },
      { token: 'identifier', foreground: 'd8e4de' },
      { token: 'delimiter', foreground: '9fb0a8' },
    ],
    colors: {
      'editor.background': '#0d1512',
      'editor.foreground': '#d8e4de',
      'editorLineNumber.foreground': '#3a4a42',
      'editorLineNumber.activeForeground': '#7c8d85',
      'editorCursor.foreground': '#19c37d',
      'editor.selectionBackground': '#19c37d3d',
      'editorGutter.background': '#0d1512',
      'editorWidget.background': '#111b17',
      'editorWidget.border': '#223229',
      'editorSuggestWidget.background': '#111b17',
      'editorHoverWidget.background': '#111b17',
      'editorHoverWidget.border': '#223229',
    },
  })
}

// The only modules the sandbox can import: the real bundled engine and analyzer.
const MODULES: Record<string, Record<string, unknown>> = {
  'fhirpath-ts/r4': { r4, r4Model },
  'fhirpath-ts/analyzer': { analyzeExpression },
}

type OutputLevel = 'log' | 'warn' | 'error' | 'throw'
interface OutputLine {
  level: OutputLevel
  text: string
}

function formatArg(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (value === undefined) {
    return 'undefined'
  }
  const json = JSON.stringify(value)
  return json ?? String(value)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Transpile the buffer with Monaco's TS worker and run it, capturing console output. */
async function runCode(model: monaco.editor.ITextModel): Promise<OutputLine[]> {
  const out: OutputLine[] = []
  let js: string
  try {
    const getWorker = await monaco.languages.typescript.getTypeScriptWorker()
    const client = await getWorker(model.uri)
    const emit = await client.getEmitOutput(model.uri.toString())
    js = emit.outputFiles.find(f => f.name.endsWith('.js'))?.text ?? ''
  } catch (error) {
    out.push({ level: 'throw', text: `Could not compile: ${errorText(error)}` })
    return out
  }

  const sandboxConsole = {
    log: (...args: unknown[]) => out.push({ level: 'log', text: args.map(formatArg).join(' ') }),
    info: (...args: unknown[]) => out.push({ level: 'log', text: args.map(formatArg).join(' ') }),
    warn: (...args: unknown[]) => out.push({ level: 'warn', text: args.map(formatArg).join(' ') }),
    error: (...args: unknown[]) => out.push({ level: 'error', text: args.map(formatArg).join(' ') }),
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
    // The buffer is the user's own code, transpiled above; running it is the point.
    const fn = new Function('require', 'exports', 'module', 'console', js)
    fn(requireShim, moduleObj.exports, moduleObj, sandboxConsole)
  } catch (error) {
    out.push({ level: 'throw', text: errorText(error) })
  }
  if (out.length === 0) {
    out.push({ level: 'log', text: '(ran with no console output)' })
  }
  return out
}

function outputRow(line: OutputLine): HTMLElement {
  const row = document.createElement('div')
  row.className = `pg-row pg-out pg-out-${line.level}`
  const badge = document.createElement('span')
  badge.className = 'pg-at'
  badge.textContent = line.level === 'throw' ? 'throws' : line.level
  const msg = document.createElement('span')
  msg.className = 'pg-msg'
  msg.textContent = line.text
  row.append(badge, msg)
  return row
}

function problemRow(marker: monaco.editor.IMarker): HTMLElement {
  const isError = marker.severity === monaco.MarkerSeverity.Error
  const source = marker.owner === 'fhirpath' ? 'analyzer' : 'tsc'
  const row = document.createElement('div')
  row.className = `pg-row pg-problem-${isError ? 'error' : 'warning'}`
  const badge = document.createElement('span')
  badge.className = 'pg-at'
  badge.textContent = `${source} · ${marker.startLineNumber}:${marker.startColumn}`
  const msg = document.createElement('span')
  msg.className = 'pg-msg'
  // tsc messages nest onto several lines; the first line is the summary
  // (the full text stays on the editor hover).
  msg.textContent = marker.message.split('\n')[0] ?? marker.message
  row.append(badge, msg)
  return row
}

/** Render run output first (gray), then the tsc + analyzer problems, into the panel. */
function render(panelEl: HTMLElement, model: monaco.editor.ITextModel, outputs: OutputLine[]): void {
  const markers = monaco.editor
    .getModelMarkers({ resource: model.uri })
    .filter(m => m.severity === monaco.MarkerSeverity.Error || m.severity === monaco.MarkerSeverity.Warning)
    .sort((a, b) => a.startLineNumber - b.startLineNumber || a.startColumn - b.startColumn)

  const rows = [...outputs.map(outputRow), ...markers.map(problemRow)]
  if (rows.length === 0) {
    const clean = document.createElement('p')
    clean.className = 'pg-clean'
    clean.textContent = 'No problems. Press Run to see output, or edit the code.'
    panelEl.replaceChildren(clean)
    return
  }
  panelEl.replaceChildren(...rows)
}

/** Render the example tabs; clicking one loads its sample into the editor. */
function renderTabs(into: HTMLElement, active: string, onSelect: (sample: Sample) => void): void {
  into.replaceChildren(
    ...SAMPLES.map(sample => {
      const button = document.createElement('button')
      button.type = 'button'
      button.role = 'tab'
      button.className = 'tab'
      button.textContent = sample.label
      button.setAttribute('aria-selected', String(sample.id === active))
      button.addEventListener('click', () => onSelect(sample))
      return button
    })
  )
}

let mounted = false

/** Build the tabbed, runnable editor using the `[data-pg-*]` children of `root`. Idempotent. */
export function mountPlayground(root: HTMLElement): void {
  if (mounted) {
    return
  }
  mounted = true
  configureTypeScript()

  const tabsEl = root.querySelector<HTMLElement>('[data-pg-tabs]')!
  const editorEl = root.querySelector<HTMLElement>('[data-pg-editor]')!
  const panelEl = root.querySelector<HTMLElement>('[data-pg-panel]')!
  const runBtn = root.querySelector<HTMLButtonElement>('[data-pg-run]')!
  editorEl.replaceChildren()

  const first = SAMPLES[0]!
  const model = monaco.editor.createModel(first.code, 'typescript', monaco.Uri.parse('file:///main.ts'))
  const editor = monaco.editor.create(editorEl, {
    model,
    theme: 'fhirpath-dark',
    fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
    fontSize: 13,
    lineHeight: 21,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    automaticLayout: true,
    padding: { top: 14, bottom: 14 },
    renderLineHighlight: 'none',
    overviewRulerLanes: 0,
    // Long lines scroll horizontally rather than wrapping.
    wordWrap: 'off',
    scrollbar: { alwaysConsumeMouseWheel: false },
    tabSize: 2,
    fixedOverflowWidgets: true,
  })

  let outputs: OutputLine[] = []

  const lint = (): void => {
    const markers: monaco.editor.IMarkerData[] = []
    for (const site of scanExpressions(model.getValue())) {
      for (const diagnostic of analyzeExpression(site.expression, { model: r4Model })) {
        const start = model.getPositionAt(site.contentStart + diagnostic.span.start)
        const end = model.getPositionAt(site.contentStart + diagnostic.span.end)
        markers.push({
          startLineNumber: start.lineNumber,
          startColumn: start.column,
          endLineNumber: end.lineNumber,
          endColumn: end.column,
          message: `[${diagnostic.code}] ${diagnostic.message}`,
          severity: diagnostic.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
        })
      }
    }
    monaco.editor.setModelMarkers(model, 'fhirpath', markers)
  }

  let timer: ReturnType<typeof setTimeout>
  model.onDidChangeContent(() => {
    clearTimeout(timer)
    timer = setTimeout(lint, 200)
  })
  monaco.editor.onDidChangeMarkers(uris => {
    if (uris.some(u => u.toString() === model.uri.toString())) {
      render(panelEl, model, outputs)
    }
  })

  let running = false
  const doRun = async (): Promise<void> => {
    if (running) {
      return
    }
    running = true
    runBtn.disabled = true
    runBtn.textContent = 'Running…'
    try {
      outputs = await runCode(model)
      render(panelEl, model, outputs)
    } finally {
      running = false
      runBtn.disabled = false
      runBtn.textContent = 'Run ▸'
    }
  }
  runBtn.addEventListener('click', () => void doRun())
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
    if (!runBtn.hidden) {
      void doRun()
    }
  })

  const select = (sample: Sample): void => {
    outputs = []
    runBtn.hidden = !sample.runnable
    model.setValue(sample.code)
    // Drop the previous tab's output and stale markers right away; lint() and the
    // TS worker repopulate diagnostics for the new code.
    monaco.editor.setModelMarkers(model, 'typescript', [])
    lint()
    render(panelEl, model, outputs)
    renderTabs(tabsEl, sample.id, select)
  }
  select(first)
}
