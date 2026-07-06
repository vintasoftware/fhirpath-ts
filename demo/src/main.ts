import { run } from './engine.ts'
import { type Tab, TABS } from './examples.ts'
import './styles.css'

const $ = <T extends Element>(sel: string) => document.querySelector<T>(sel)!

const exprEl = $<HTMLTextAreaElement>('[data-expr]')
const highlightEl = $<HTMLDivElement>('[data-highlight]')
const chipsEl = $<HTMLDivElement>('[data-chips]')
const tabsEl = $<HTMLDivElement>('[data-tabs]')
const resourceEl = $<HTMLPreElement>('[data-resource]')
const resultEl = $<HTMLDivElement>('[data-result]')
const resultCountEl = $<HTMLSpanElement>('[data-result-count]')
const inputTypeEl = $<HTMLSpanElement>('[data-input-type]')
const readoutEl = $<HTMLDivElement>('[data-readout]')
const readoutLineEl = $<HTMLParagraphElement>('[data-readout-line]')
const diagsEl = $<HTMLUListElement>('[data-diags]')
const traceEl = $<SVGSVGElement>('[data-trace]')

let activeTab: Tab = TABS[0]!

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))
}

// --- Chrome: tabs, chips, resource -----------------------------------------

function renderTabs() {
  tabsEl.replaceChildren(
    ...TABS.map((tab) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.role = 'tab'
      b.textContent = tab.label
      b.className = 'tab'
      b.setAttribute('aria-selected', String(tab.id === activeTab.id))
      b.addEventListener('click', () => selectTab(tab))
      return b
    })
  )
}

function renderChips() {
  chipsEl.replaceChildren(
    ...activeTab.examples.map((ex) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'chip'
      b.textContent = ex.expr
      b.title = ex.note
      b.addEventListener('click', () => {
        setExpression(ex.expr)
        exprEl.focus()
      })
      return b
    })
  )
}

function selectTab(tab: Tab) {
  activeTab = tab
  renderTabs()
  renderChips()
  resourceEl.textContent = JSON.stringify(tab.resource, null, 2)
  inputTypeEl.textContent = `input: ${tab.resourceType}`
  setExpression(tab.examples[0]!.expr)
}

// --- Editor: value, autosize, highlight overlay ----------------------------

function setExpression(value: string) {
  exprEl.value = value
  evaluate()
}

function autosize() {
  exprEl.style.height = 'auto'
  exprEl.style.height = `${exprEl.scrollHeight}px`
  highlightEl.style.height = `${exprEl.scrollHeight}px`
}

/** Paint the expression behind the textarea, marking each flagged span. */
function paintHighlight(expr: string, spans: Array<{ start: number; end: number; severity: string }>) {
  const ordered = [...spans].sort((a, b) => a.start - b.start)
  let html = ''
  let cursor = 0
  for (const s of ordered) {
    const start = Math.max(cursor, Math.min(s.start, expr.length))
    const end = Math.max(start, Math.min(s.end, expr.length))
    if (start > cursor) html += escapeHtml(expr.slice(cursor, start))
    html += `<mark class="mk-${s.severity}">${escapeHtml(expr.slice(start, end)) || '&nbsp;'}</mark>`
    cursor = end
  }
  html += escapeHtml(expr.slice(cursor))
  highlightEl.innerHTML = html
}

// --- The signature: the diagnostic baseline --------------------------------

function paintTrace(state: 'ok' | 'warn' | 'error', columnRatio: number) {
  const W = 600
  const y = 22
  let shape: string
  if (state === 'error') {
    const x = Math.round(20 + columnRatio * (W - 40))
    shape = `M0 ${y} H${x - 14} L${x - 6} 6 L${x + 6} 38 L${x + 14} ${y} H${W}`
  } else if (state === 'warn') {
    const x = Math.round(20 + columnRatio * (W - 40))
    shape = `M0 ${y} H${x - 12} Q${x} 8 ${x + 12} ${y} H${W}`
  } else {
    shape = `M0 ${y} H${W}`
  }
  traceEl.innerHTML = `<path class="trace-base" d="${shape}" />`
}

// --- Results ----------------------------------------------------------------

function renderResults(
  results: { type: string; text: string }[] | null,
  runtimeError: string | null
) {
  if (runtimeError) {
    resultCountEl.textContent = 'throws'
    resultEl.className = 'result is-throw'
    resultEl.innerHTML = `<p class="throw-head">This throws at runtime</p><p class="throw-msg">${escapeHtml(runtimeError)}</p>`
    return
  }
  resultEl.className = 'result'
  if (!results || results.length === 0) {
    resultCountEl.textContent = '0 values'
    resultEl.innerHTML = `<p class="empty">No values. The path matched nothing in this resource.</p>`
    return
  }
  resultCountEl.textContent = `${results.length} ${results.length === 1 ? 'value' : 'values'}`
  resultEl.replaceChildren(
    ...results.map((r) => {
      const row = document.createElement('div')
      row.className = 'result-row'
      row.innerHTML = `<span class="type-badge">${escapeHtml(r.type)}</span><span class="value">${escapeHtml(r.text)}</span>`
      return row
    })
  )
}

// --- Orchestration ----------------------------------------------------------

function evaluate() {
  const expr = exprEl.value
  autosize()

  if (expr.trim() === '') {
    paintHighlight(expr, [])
    paintTrace('ok', 1)
    readoutEl.dataset.state = 'idle'
    readoutLineEl.textContent = 'Type a FHIRPath expression to begin.'
    diagsEl.replaceChildren()
    resultCountEl.textContent = ''
    resultEl.className = 'result'
    resultEl.innerHTML = '<p class="empty">Waiting for an expression.</p>'
    return
  }

  const { diagnostics, results, runtimeError } = run(expr, activeTab.resourceType, activeTab.resource)

  const spans = diagnostics.map((d) => ({ start: d.span.start, end: d.span.end, severity: d.severity }))
  paintHighlight(expr, spans)

  const hasError = diagnostics.some((d) => d.severity === 'error')
  const hasWarn = !hasError && diagnostics.length > 0
  const state = hasError ? 'error' : hasWarn ? 'warn' : 'ok'
  const first = diagnostics[0]
  const ratio = first ? first.span.start / Math.max(expr.length, 1) : 1
  paintTrace(state, ratio)

  readoutEl.dataset.state = state
  if (diagnostics.length === 0) {
    readoutLineEl.textContent = 'No problems. Safe to run against a real resource.'
  } else {
    const n = diagnostics.length
    readoutLineEl.textContent = `${n} ${n === 1 ? 'problem' : 'problems'} found before running:`
  }

  diagsEl.replaceChildren(
    ...diagnostics.map((d) => {
      const li = document.createElement('li')
      li.className = `diag diag-${d.severity}`
      li.innerHTML = `<code class="diag-code">${escapeHtml(d.code)}</code><span class="diag-msg">${escapeHtml(d.message)}</span>`
      return li
    })
  )

  renderResults(results, runtimeError)
}

// --- Boot -------------------------------------------------------------------

$<HTMLPreElement>('[data-quickstart]').textContent = `import { compile, evaluate } from 'fhirpath-ts'
import { r4Model } from 'fhirpath-ts/r4'
import { analyzeExpression } from 'fhirpath-ts/analyzer'

// Result type is inferred by tsc — no plugin:
const given = compile('Patient.name.given')
given.evaluate(patient, { model: r4Model })        // string[]

// Check an expression before it ships:
analyzeExpression('Observation.valueQuantity', { model: r4Model, inputType: 'Observation' })
// -> [{ code: 'unknown-element', message: "...use the choice stem 'value'...", ... }]`

exprEl.addEventListener('input', evaluate)
window.addEventListener('resize', autosize)
renderTabs()
selectTab(TABS[0]!)
