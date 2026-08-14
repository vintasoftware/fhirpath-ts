/**
 * Ctrl+Arrow word movement for the expression textarea, the counterpart of the
 * playground editor's Monaco keybindings (see playground/monaco.ts). macOS browsers
 * reserve word movement for Option+Arrow, so Ctrl+Arrow does nothing there by
 * default; Windows and Linux browsers already move the caret by word on
 * Ctrl+Arrow and keep their native behavior.
 */
export function bindTextareaWordNavigation(el: HTMLTextAreaElement): void {
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
    // While the textarea has focus, the document selection steers its caret,
    // with the platform's own word boundaries and selection-anchor handling.
    // Firefox keeps text-control selections out of getSelection(), so there
    // this stays inert — the same as Ctrl+Arrow without the handler.
    const alter = event.shiftKey ? 'extend' : 'move'
    const direction = event.key === 'ArrowLeft' ? 'left' : 'right'
    document.getSelection()?.modify(alter, direction, 'word')
  })
}
