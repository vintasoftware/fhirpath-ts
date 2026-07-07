/**
 * The "Try it in your own code" playground. A Monaco editor whose built-in
 * TypeScript worker type-checks the code against fhirpath-ts's real declarations
 * (bundled into src/monaco/*.d.ts), so the inferred result types and the input
 * mismatches surface exactly as they would in your editor. On top of that we run
 * the §11 analyzer over the FHIRPath literals the code contains — the same check
 * the fhirpath-check CLI and the ESLint rule run — and show both as markers and
 * in a problems list. Everything runs client-side; nothing leaves the browser.
 */

import { analyzeExpression } from 'fhirpath-ts/analyzer'
import { r4Model } from 'fhirpath-ts/r4'
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

const SAMPLE = `import { r4 } from 'fhirpath-ts/r4'
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
`

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
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    strict: true,
    noEmit: true,
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

/** Render the combined tsc + analyzer problem list under the editor. */
function renderProblems(model: monaco.editor.ITextModel, into: HTMLElement): void {
  const markers = monaco.editor
    .getModelMarkers({ resource: model.uri })
    .filter(m => m.severity === monaco.MarkerSeverity.Error || m.severity === monaco.MarkerSeverity.Warning)
    .sort((a, b) => a.startLineNumber - b.startLineNumber || a.startColumn - b.startColumn)

  if (markers.length === 0) {
    into.innerHTML = `<p class="pg-clean">No problems. tsc and the analyzer are both happy.</p>`
    return
  }

  into.replaceChildren(
    ...markers.map(m => {
      const isError = m.severity === monaco.MarkerSeverity.Error
      const source = m.owner === 'fhirpath' ? 'analyzer' : 'tsc'
      const row = document.createElement('div')
      row.className = `pg-problem pg-problem-${isError ? 'error' : 'warning'}`
      const at = document.createElement('span')
      at.className = 'pg-at'
      at.textContent = `${source} · ${m.startLineNumber}:${m.startColumn}`
      const msg = document.createElement('span')
      msg.className = 'pg-msg'
      // tsc messages nest onto several lines; the first line is the summary
      // (the full text stays on the editor hover).
      msg.textContent = m.message.split('\n')[0] ?? m.message
      row.append(at, msg)
      return row
    })
  )
}

let mounted = false

/** Build the editor in `editorEl` and stream problems into `problemsEl`. Idempotent. */
export function mountPlayground(editorEl: HTMLElement, problemsEl: HTMLElement): void {
  if (mounted) {
    return
  }
  mounted = true
  configureTypeScript()

  const model = monaco.editor.createModel(SAMPLE, 'typescript', monaco.Uri.parse('file:///main.ts'))
  monaco.editor.create(editorEl, {
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
    scrollbar: { alwaysConsumeMouseWheel: false },
    wordWrap: 'on',
    tabSize: 2,
    fixedOverflowWidgets: true,
  })

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
    timer = setTimeout(lint, 150)
  })
  monaco.editor.onDidChangeMarkers(uris => {
    if (uris.some(u => u.toString() === model.uri.toString())) {
      renderProblems(model, problemsEl)
    }
  })
  lint()
}
