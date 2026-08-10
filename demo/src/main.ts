import './styles.css'
// The editor loads lazily, but its frame's styles do not: the frame reserves the
// section's height so nothing jumps when Monaco mounts into it.
import './playground/playground.css'

import { $, escapeHtml, renderTabs } from './dom.ts'
import { run } from './engine.ts'
import { type Tab, TABS } from './examples.ts'
import { highlightBlocks } from './highlight.ts'

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

// --- Chrome: tabs, chips, resource -----------------------------------------

function renderChips() {
  chipsEl.replaceChildren(
    ...activeTab.examples.map(ex => {
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
  renderTabs(tabsEl, TABS, tab.id, selectTab)
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
    if (start > cursor) {
      html += escapeHtml(expr.slice(cursor, start))
    }
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
  runtimeError: string | null,
  caughtStatically: boolean
) {
  if (runtimeError) {
    resultEl.className = 'result is-throw'
    if (caughtStatically) {
      // The analyzer already flagged this above — the throw is what you avoided,
      // Explain that runtime is only one of three places that can report the error.
      resultCountEl.textContent = 'caught first'
      resultEl.innerHTML =
        `<p class="throw-head throw-head-caught">Caught above, before you ran it</p>` +
        `<p class="throw-note">The analyzer flagged this statically. Run it anyway and it throws:</p>` +
        `<p class="throw-msg">${escapeHtml(runtimeError)}</p>`
    } else {
      resultCountEl.textContent = 'throws'
      resultEl.innerHTML =
        `<p class="throw-head">Only surfaces at runtime</p>` + `<p class="throw-msg">${escapeHtml(runtimeError)}</p>`
    }
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
    ...results.map(r => {
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

  const spans = diagnostics.map(d => ({ start: d.span.start, end: d.span.end, severity: d.severity }))
  paintHighlight(expr, spans)

  const hasError = diagnostics.some(d => d.severity === 'error')
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
    ...diagnostics.map(d => {
      const li = document.createElement('li')
      li.className = `diag diag-${d.severity}`
      li.innerHTML = `<code class="diag-code">${escapeHtml(d.code)}</code><span class="diag-msg">${escapeHtml(d.message)}</span>`
      return li
    })
  )

  renderResults(results, runtimeError, hasError)
}

// --- Boot -------------------------------------------------------------------

// Highlight the static example blocks in the "Where a mistake gets caught" section.
highlightBlocks('.layer-code')

// The playground pulls in Monaco (heavy), so load it only once the section is
// near the viewport rather than blocking the initial page.
const playgroundEl = $<HTMLDivElement>('[data-playground]')
const observer = new IntersectionObserver(
  entries => {
    if (!entries.some(e => e.isIntersecting)) {
      return
    }
    observer.disconnect()
    void import('./playground/index.ts').then(
      module => module.mountPlayground(playgroundEl),
      () => {
        $<HTMLParagraphElement>('.pg-loading', playgroundEl).textContent =
          'The editor could not load. The examples below still show what it does.'
      }
    )
  },
  { rootMargin: '400px' }
)
observer.observe(playgroundEl)

exprEl.addEventListener('input', evaluate)
window.addEventListener('resize', autosize)
selectTab(TABS[0]!)
