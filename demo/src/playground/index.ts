/**
 * The "Edit it — checked live" playground. A Monaco editor whose TypeScript worker
 * type-checks the buffer against fhirpath-ts's real declarations (bundled into
 * src/monaco/*.d.ts), so the inferred result types and the input mismatches surface
 * exactly as they would in your editor. On top of that the §11 analyzer runs over
 * the FHIRPath literals the buffer contains — found with the same TypeScript-AST
 * walker the fhirpath-check CLI uses, running inside Monaco's own worker where
 * the compiler already lives (see ts.custom.worker.ts).
 *
 * Each sample owns its model, so its markers, its output and the reader's edits all
 * belong to it and a tab switch cannot spill one tab's state into another.
 */

import { analyzeSite } from 'fhirpath-ts/analyzer'
import { r4Model } from 'fhirpath-ts/r4'
import type { ExpressionSite } from 'fhirpath-ts/sites'

import { $, renderTabs } from '../dom.ts'
import { ANALYZER_OWNER, configureMonaco, monaco, THEME_NAME, tsWorkerHandle } from './monaco.ts'
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

// project() sets %rowIndex/%rowTotal per row at runtime; declared here so the samples
// that use them lint clean (the analyzer has no notion of the call site).
const PROJECT_ROW_VARIABLES = {
  rowIndex: { types: ['System.Integer'], single: true },
  rowTotal: { types: ['System.Integer'], single: true },
}

/**
 * Ask the TypeScript worker for the buffer's expression sites. Extraction rides
 * the worker Monaco already runs (see ts.custom.worker.ts) — the compiler is
 * there, the main thread stays free, and each request is matched to its reply
 * by id so answers can never cross.
 */
let sitesRequestId = 0
const pendingSites = new Map<number, (sites: ExpressionSite[]) => void>()

async function requestSites(text: string): Promise<ExpressionSite[]> {
  const worker = await tsWorkerHandle()
  const id = ++sitesRequestId
  if (pendingSites.size === 0) {
    worker.addEventListener('message', receiveSites)
  }
  return new Promise(resolve => {
    pendingSites.set(id, resolve)
    worker.postMessage({ fhirpathSites: id, text })
  })
}

function receiveSites(event: MessageEvent): void {
  const data = event.data as { fhirpathSites?: number; sites?: ExpressionSite[] } | null
  if (typeof data?.fhirpathSites !== 'number' || data.sites === undefined) {
    return // Monaco protocol traffic on the same worker.
  }
  pendingSites.get(data.fhirpathSites)?.(data.sites)
  pendingSites.delete(data.fhirpathSites)
}

/** Publish the analyzer's findings for `model` under its own marker owner. */
async function lint(model: monaco.editor.ITextModel): Promise<void> {
  const version = model.getVersionId()
  const sites = await requestSites(model.getValue())
  if (model.isDisposed() || model.getVersionId() !== version) {
    return // The buffer moved on; the keystroke that changed it re-linted.
  }
  const markers: monaco.editor.IMarkerData[] = []
  for (const site of sites) {
    // analyzeSite applies each site's own context: a DTO `@column` field runs
    // against its class's fhirType (see the dto sample).
    for (const diagnostic of analyzeSite(site, { model: r4Model, variables: PROJECT_ROW_VARIABLES })) {
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
      timer = setTimeout(() => void lint(model), LINT_DELAY_MS)
    })
    void lint(model)
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
