/** The output panel under the editor: run output first, then the problems. */

import { ANALYZER_OWNER, monaco } from './monaco.ts'
import type { OutputLine } from './sandbox.ts'

/** One row: a badge saying where the line came from, then the message. */
function row(className: string, badge: string, message: string): HTMLElement {
  const element = document.createElement('div')
  element.className = `pg-row ${className}`
  const at = document.createElement('span')
  at.className = 'pg-at'
  at.textContent = badge
  const text = document.createElement('span')
  text.className = 'pg-msg'
  text.textContent = message
  element.append(at, text)
  return element
}

const outputRow = (line: OutputLine): HTMLElement =>
  row(`pg-out pg-out-${line.level}`, line.level === 'throw' ? 'throws' : line.level, line.text)

const problemRow = (marker: monaco.editor.IMarker): HTMLElement =>
  row(
    `pg-problem-${marker.severity === monaco.MarkerSeverity.Error ? 'error' : 'warning'}`,
    `${marker.owner === ANALYZER_OWNER ? 'analyzer' : 'tsc'} · ${marker.startLineNumber}:${marker.startColumn}`,
    // tsc messages nest onto several lines; the first line is the summary
    // (the full text stays on the editor hover).
    marker.message.split('\n')[0] ?? marker.message
  )

/** The model's errors and warnings from every owner, in source order. */
function problems(model: monaco.editor.ITextModel): monaco.editor.IMarker[] {
  return monaco.editor
    .getModelMarkers({ resource: model.uri })
    .filter(
      marker => marker.severity === monaco.MarkerSeverity.Error || marker.severity === monaco.MarkerSeverity.Warning
    )
    .sort((a, b) => a.startLineNumber - b.startLineNumber || a.startColumn - b.startColumn)
}

export function renderPanel(into: HTMLElement, model: monaco.editor.ITextModel, outputs: OutputLine[]): void {
  const rows = [...outputs.map(outputRow), ...problems(model).map(problemRow)]
  if (rows.length === 0) {
    const clean = document.createElement('p')
    clean.className = 'pg-clean'
    clean.textContent = 'No problems. Press Run to see output, or edit the code.'
    into.replaceChildren(clean)
    return
  }
  into.replaceChildren(...rows)
}
