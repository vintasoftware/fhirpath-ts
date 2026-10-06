import fc from 'fast-check'
import { type DefaultTreeAdapterMap, html, parseFragment } from 'parse5'
import { describe, expect, it } from 'vitest'

import { ALLOWED_ATTRIBUTES, ALLOWED_ELEMENTS, validateNarrative } from './html-checks.ts'

/**
 * Compares validateNarrative() with an HTML parser. parse5 follows the HTML
 * parsing algorithm browsers use for innerHTML. For every narrative the
 * validator accepts, the tree a browser builds must also hold only allowed
 * elements and attributes and inert URLs. The generator mixes valid markup
 * with forms where XML and HTML parsing disagree.
 */

type Node = DefaultTreeAdapterMap['childNode']

const ELEMENTS = ['p', 'b', 'i', 'a', 'img', 'br', 'span', 'table', 'tr', 'td', 'pre', 'ul', 'li', 'div', 'h1']
const BLOCKED_ELEMENTS = ['script', 'style', 'svg', 'math', 'iframe', 'textarea', 'title', 'template', 'xmp', 'button']
const ATTRIBUTES = ['title', 'class', 'style', 'href', 'src', 'alt', 'name', 'id', 'xmlns', 'xml:lang', 'lang']
const BLOCKED_ATTRIBUTES = ['onclick', 'onerror', 'srcdoc', 'formaction']

const URLS = [
  'https://example.org/a?b=1&amp;c=2',
  '#fragment',
  'relative/page.html',
  'mailto:doc@example.org',
  'data:image/png;base64,AAAA',
  'javascript:x()',
  'JaVaScRiPt:x()',
  'java&#115;cript:x()',
  '&#106avascript:x()',
  'javascript&#58x()',
  '&#x6A;avascript:x()',
  'java\tscript:x()',
  ' \njavascript:x()',
  '&#0;javascript:x()',
  'vbscript:x()',
  'data:text/html,x',
]

const TEXT = [
  'text',
  ' ',
  '\n',
  '&amp;',
  '&lt;',
  '&gt;',
  '&#106;',
  '&#x1F600;',
  '&',
  '&#106',
  '&nbsp;',
  ']]>',
  '>',
  '"',
  "'",
]

// Raw fragments that can change how either parser reads what follows them.
const RAW = [
  '<!-- note -->',
  '<!---->',
  '<!-->',
  '<!--->',
  '<!--',
  '-->',
  '--!>',
  '<![CDATA[x]]>',
  '<![CDATA[',
  '<![CDATA[>',
  '<!DOCTYPE html>',
  '<?x y?>',
  '</p>',
  '</div>',
  '<p/>',
  '<br>',
  '<br/>',
  '<',
  '/>',
  '=',
]

const XHTML_ROOT = '<div xmlns="http://www.w3.org/1999/xhtml">'

const attributeArb = fc
  .tuple(
    fc.oneof(
      { weight: 8, arbitrary: fc.constantFrom(...ATTRIBUTES) },
      { weight: 1, arbitrary: fc.constantFrom(...BLOCKED_ATTRIBUTES) }
    ),
    fc.oneof(fc.constantFrom(...URLS), fc.constantFrom(...TEXT), fc.constant('http://www.w3.org/1999/xhtml')),
    fc.constantFrom('"', "'", ''),
    fc.constantFrom(' ', ' ', '\t', '\n', '', '/')
  )
  .map(([name, value, quote, separator]) => `${separator}${name}=${quote}${value}${quote}`)

const { node: nodeArb } = fc.letrec<{ node: string; element: string }>(tie => ({
  node: fc.oneof(
    { weight: 4, arbitrary: fc.constantFrom(...TEXT) },
    { weight: 2, arbitrary: fc.constantFrom(...RAW) },
    { weight: 3, arbitrary: tie('element') }
  ),
  element: fc
    .tuple(
      fc.oneof(
        { weight: 8, arbitrary: fc.constantFrom(...ELEMENTS) },
        { weight: 1, arbitrary: fc.constantFrom(...BLOCKED_ELEMENTS) }
      ),
      fc.array(attributeArb, { maxLength: 3 }),
      fc.array(tie('node'), { maxLength: 4 }),
      fc.boolean()
    )
    .map(([name, attributes, children, selfClosing]) =>
      selfClosing ? `<${name}${attributes.join('')}/>` : `<${name}${attributes.join('')}>${children.join('')}</${name}>`
    ),
}))

const narrativeArb = fc
  .tuple(fc.array(nodeArb, { maxLength: 6 }), fc.boolean())
  .map(([children, wrapped]) => (wrapped ? `${XHTML_ROOT}${children.join('')}</div>` : children.join('')))

/** The first violation in the browser's tree, or undefined when it is inert. */
function browserViolation(markup: string): string | undefined {
  const pending: Node[] = [...parseFragment(markup).childNodes]
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (!('tagName' in node)) {
      continue
    }
    if (node.namespaceURI !== html.NS.HTML || !ALLOWED_ELEMENTS.has(node.tagName)) {
      return `element ${node.tagName} (${node.namespaceURI})`
    }
    for (const { name, value } of node.attrs) {
      if (!ALLOWED_ATTRIBUTES.has(name)) {
        return `attribute ${name} on ${node.tagName}`
      }
      if ((name === 'href' || name === 'src') && !inertUrl(value, name)) {
        return `${name}="${value}" on ${node.tagName}`
      }
    }
    pending.push(...node.childNodes)
  }
  return undefined
}

/** The URL as a browser resolves it after removing control characters and spaces. */
function inertUrl(value: string, attribute: string): boolean {
  // eslint-disable-next-line no-control-regex -- browsers skip these before reading the scheme
  const url = value.replace(/[\u0000- ]/g, '')
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase()
  return (
    scheme === undefined ||
    ['http', 'https', 'mailto', 'tel', 'ftp', 'urn', 'cid'].includes(scheme) ||
    (attribute === 'src' && /^data:image\//i.test(url))
  )
}

describe('narrative validation against an HTML parser', () => {
  it('a browser sees only allowed markup in every accepted narrative', () => {
    let accepted = 0
    fc.assert(
      fc.property(narrativeArb, markup => {
        if (!validateNarrative(markup)) {
          return true
        }
        accepted += 1
        expect(browserViolation(markup), markup).toBeUndefined()
        return true
      }),
      // CI budget: fresh random cases per run (unseeded, so coverage grows over time).
      { numRuns: 3000 }
    )
    // Keep the property meaningful: the generator must produce accepted narratives.
    expect(accepted).toBeGreaterThan(100)
  })

  it.each([
    `${XHTML_ROOT}<!--><script>x()</script>--></div>`,
    `${XHTML_ROOT}<![CDATA[><script>x()</script>]]></div>`,
    `${XHTML_ROOT}<a href="&#106avascript:x()">t</a></div>`,
  ])('the oracle flags the known bypass %s', markup => {
    expect(browserViolation(markup)).toBeDefined()
    expect(validateNarrative(markup)).toBe(false)
  })
})
