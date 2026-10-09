/** The DOM helpers both the evaluator panel and the playground need. */

/** The one element matching `selector`, which the page is expected to contain. */
export const $ = <T extends Element>(selector: string, within: ParentNode = document): T =>
  within.querySelector<T>(selector)!

export function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, char => (char === '&' ? '&amp;' : char === '<' ? '&lt;' : '&gt;'))
}

export interface TabItem {
  id: string
  label: string
}

/**
 * Fill `into` with a tab button per item. Re-rendering is how the selection
 * changes, so callers can call this again with a new `activeId`.
 */
export function renderTabs<T extends TabItem>(
  into: HTMLElement,
  items: readonly T[],
  activeId: string,
  onSelect: (item: T) => void
): void {
  into.replaceChildren(
    ...items.map(item => {
      const button = document.createElement('button')
      button.type = 'button'
      button.role = 'tab'
      button.className = 'tab'
      button.textContent = item.label
      button.setAttribute('aria-selected', String(item.id === activeId))
      button.addEventListener('click', () => onSelect(item))
      return button
    })
  )
}

/** Read a CSS custom property off `:root`, so one palette drives CSS and canvas alike. */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}
