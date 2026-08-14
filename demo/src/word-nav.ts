/**
 * Ctrl+Arrow word movement for the expression textarea, matching the playground
 * editor's binding. macOS browsers reserve word movement for Option+Arrow, so
 * Ctrl+Arrow does nothing there by default; Windows and Linux browsers already
 * move the caret by word on Ctrl+Arrow and keep their native behavior.
 */

const WORD_CHAR = /[A-Za-z0-9_]/

/** The offset just past the end of the word the caret is in or before. */
export function nextWordBoundary(text: string, offset: number): number {
  let i = offset
  while (i < text.length && !WORD_CHAR.test(text[i]!)) {
    i++
  }
  while (i < text.length && WORD_CHAR.test(text[i]!)) {
    i++
  }
  return i
}

/** The offset at the start of the word the caret is in or after. */
export function prevWordBoundary(text: string, offset: number): number {
  let i = offset
  while (i > 0 && !WORD_CHAR.test(text[i - 1]!)) {
    i--
  }
  while (i > 0 && WORD_CHAR.test(text[i - 1]!)) {
    i--
  }
  return i
}

export function bindWordNavigation(el: HTMLTextAreaElement): void {
  if (!navigator.platform.startsWith('Mac')) {
    return
  }
  el.addEventListener('keydown', event => {
    if (!event.ctrlKey || event.metaKey || event.altKey) {
      return
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return
    }
    event.preventDefault()
    const text = el.value
    const backward = event.key === 'ArrowLeft'
    const start = el.selectionStart
    const end = el.selectionEnd
    if (event.shiftKey) {
      // Keep the anchor where the selection began and move only the focus end.
      const anchorIsStart = el.selectionDirection !== 'backward'
      const anchor = anchorIsStart ? start : end
      const focus = anchorIsStart ? end : start
      const moved = backward ? prevWordBoundary(text, focus) : nextWordBoundary(text, focus)
      el.setSelectionRange(Math.min(anchor, moved), Math.max(anchor, moved), moved < anchor ? 'backward' : 'forward')
    } else {
      const collapsed = backward ? prevWordBoundary(text, start) : nextWordBoundary(text, end)
      el.setSelectionRange(collapsed, collapsed)
    }
  })
}
