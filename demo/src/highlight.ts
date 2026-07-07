/**
 * A tiny TypeScript syntax highlighter for the static code blocks on the page.
 * Not a full lexer — just enough to color comments, strings, numbers, keywords
 * and call sites in the demo's screen palette. Returns HTML; input is escaped.
 */

const KEYWORDS = new Set([
  'import',
  'export',
  'from',
  'const',
  'let',
  'var',
  'function',
  'return',
  'new',
  'await',
  'async',
  'type',
  'interface',
  'as',
  'of',
  'in',
  'true',
  'false',
  'null',
  'undefined',
  'void',
])

// One pass, leftmost-match wins: comment | string | number | word.
const TOKEN =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/g

function esc(s: string): string {
  return s.replace(/[&<>]/g, c => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))
}

export function highlightTs(code: string): string {
  let out = ''
  let last = 0
  for (const m of code.matchAll(TOKEN)) {
    const i = m.index
    out += esc(code.slice(last, i))
    if (m[1] !== undefined) {
      out += `<span class="tok-comment">${esc(m[1])}</span>`
    } else if (m[2] !== undefined) {
      out += `<span class="tok-string">${esc(m[2])}</span>`
    } else if (m[3] !== undefined) {
      out += `<span class="tok-num">${esc(m[3])}</span>`
    } else {
      const word = m[4]!
      if (KEYWORDS.has(word)) {
        out += `<span class="tok-keyword">${esc(word)}</span>`
      } else if (code[i + word.length] === '(') {
        out += `<span class="tok-fn">${esc(word)}</span>`
      } else {
        out += esc(word)
      }
    }
    last = i + m[0].length
  }
  out += esc(code.slice(last))
  return out
}

/** Highlight every element matching `selector`, reading its current text content. */
export function highlightBlocks(selector: string): void {
  for (const el of document.querySelectorAll<HTMLElement>(selector)) {
    el.innerHTML = highlightTs(el.textContent ?? '')
  }
}
