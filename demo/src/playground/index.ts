/**
 * The "Edit it — checked live" playground. A Monaco editor whose TypeScript worker
 * type-checks the buffer against fhirpath-ts's real declarations (bundled into
 * src/monaco/*.d.ts), so the inferred result types and the input mismatches surface
 * exactly as they would in your editor. On top of that the §11 analyzer runs over
 * the FHIRPath literals the buffer contains, found with the same walker policy the
 * fhirpath-check CLI and the ESLint rule use.
 *
 * Each sample owns its model, so its markers, its output and the reader's edits all
 * belong to it and a tab switch cannot spill one tab's state into another.
 */

import { analyzeExpression, findLexicalExpressionSites } from 'fhirpath-ts/analyzer'
import { r4Model } from 'fhirpath-ts/r4'

import { $, renderTabs } from '../dom.ts'
import { ANALYZER_OWNER, configureMonaco, monaco, THEME_NAME } from './monaco.ts'
import { renderPanel } from './panel.ts'
import { type Sample, SAMPLES } from './samples.ts'
import { type OutputLine, runModel } from './sandbox.ts'

/** How long after a keystroke the analyzer re-runs. */
const LINT_DELAY_MS = 200

/** One tab's state. Everything that can differ between tabs lives here. */
interface Tab {
  sample: Sample
  model: monaco.editor.ITextModel
  outputs: OutputLine[]
  running: boolean
}

/** Publish the analyzer's findings for `model` under its own marker owner. */
function lint(model: monaco.editor.ITextModel): void {
  const markers: monaco.editor.IMarkerData[] = []
  for (const site of findLexicalExpressionSites(model.getValue())) {
    for (const diagnostic of analyzeExpression(site.expression, { model: r4Model })) {
      const start = model.getPositionAt(site.start + diagnostic.span.start)
      const end = model.getPositionAt(site.start + diagnostic.span.end)
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
  monaco.editor.setModelMarkers(model, ANALYZER_OWNER, markers)
}

/** Build the tabbed, runnable editor from the `[data-pg-*]` children of `root`. */
export function mountPlayground(root: HTMLElement): void {
  configureMonaco()

  const tabsEl = $<HTMLElement>('[data-pg-tabs]', root)
  const editorEl = $<HTMLElement>('[data-pg-editor]', root)
  const panelEl = $<HTMLElement>('[data-pg-panel]', root)
  const runBtn = $<HTMLButtonElement>('[data-pg-run]', root)
  editorEl.replaceChildren()

  const tabs = new Map<string, Tab>()
  const tabFor = (sample: Sample): Tab => {
    const existing = tabs.get(sample.id)
    if (existing) {
      return existing
    }
    // A distinct file name per tab keeps the models — and so tsc's messages —
    // separate, and lets Monaco own each one's markers.
    const model = monaco.editor.createModel(sample.code, 'typescript', monaco.Uri.parse(`file:///${sample.id}.ts`))
    const tab: Tab = { sample, model, outputs: [], running: false }
    let timer: ReturnType<typeof setTimeout> | undefined
    model.onDidChangeContent(() => {
      clearTimeout(timer)
      timer = setTimeout(() => lint(model), LINT_DELAY_MS)
    })
    lint(model)
    tabs.set(sample.id, tab)
    return tab
  }

  let active = tabFor(SAMPLES[0]!)
  const editor = monaco.editor.create(editorEl, {
    model: active.model,
    theme: THEME_NAME,
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

  const syncRunButton = (): void => {
    runBtn.hidden = !active.sample.runnable
    runBtn.disabled = active.running
    runBtn.textContent = active.running ? 'Running…' : 'Run ▸'
  }

  const doRun = async (): Promise<void> => {
    // Capture the tab: the reader can switch tabs while the worker compiles, and
    // the result belongs to the tab that asked for it either way.
    const tab = active
    if (tab.running) {
      return
    }
    tab.running = true
    syncRunButton()
    try {
      tab.outputs = await runModel(tab.model)
    } finally {
      tab.running = false
      if (tab === active) {
        syncRunButton()
        renderPanel(panelEl, tab.model, tab.outputs)
      }
    }
  }

  const select = (sample: Sample): void => {
    active = tabFor(sample)
    editor.setModel(active.model)
    syncRunButton()
    renderPanel(panelEl, active.model, active.outputs)
    renderTabs(tabsEl, SAMPLES, sample.id, select)
  }

  runBtn.addEventListener('click', () => void doRun())
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
    if (active.sample.runnable) {
      void doRun()
    }
  })
  monaco.editor.onDidChangeMarkers(uris => {
    if (uris.some(uri => uri.toString() === active.model.uri.toString())) {
      renderPanel(panelEl, active.model, active.outputs)
    }
  })

  select(active.sample)
}
