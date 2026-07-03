/**
 * FHIR narrative validation for htmlChecks(): the xhtml must be well formed, use
 * only the elements and attributes the FHIR spec allows in Narrative.div, and
 * carry no active content. (https://hl7.org/fhir/narrative.html)
 */

const ALLOWED_ELEMENTS = new Set([
  'div',
  'p',
  'b',
  'i',
  'em',
  'strong',
  'u',
  's',
  'strike',
  'small',
  'big',
  'tt',
  'sub',
  'sup',
  'span',
  'br',
  'hr',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'table',
  'caption',
  'col',
  'colgroup',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'pre',
  'blockquote',
  'q',
  'a',
  'img',
  'code',
  'samp',
  'kbd',
  'var',
  'abbr',
  'acronym',
  'cite',
  'dfn',
  'address',
  'bdo',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
])

const VOID_ELEMENTS = new Set(['br', 'hr', 'img', 'col'])

const ALLOWED_ATTRIBUTES = new Set([
  'abbr',
  'accesskey',
  'align',
  'alt',
  'axis',
  'bgcolor',
  'border',
  'cellhalign',
  'cellpadding',
  'cellspacing',
  'cellvalign',
  'char',
  'charoff',
  'charset',
  'cite',
  'class',
  'colspan',
  'compact',
  'coords',
  'dir',
  'frame',
  'headers',
  'height',
  'href',
  'hreflang',
  'hspace',
  'id',
  'lang',
  'longdesc',
  'name',
  'nowrap',
  'rel',
  'rev',
  'rowspan',
  'rules',
  'scope',
  'shape',
  'span',
  'src',
  'start',
  'style',
  'summary',
  'tabindex',
  'title',
  'type',
  'valign',
  'value',
  'vspace',
  'width',
  'xmlns',
  'xml:id',
  'xml:lang',
  'xml:space',
])

const TAG_PATTERN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>|[^<]+/g
const OPEN_TAG = /^<([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>$/
const CLOSE_TAG = /^<\/([a-zA-Z][a-zA-Z0-9]*)\s*>$/
const ATTRIBUTE = /([^\s=>/]+)(?:\s*=\s*("[^"]*"|'[^']*'))?/g

export function validateNarrative(xhtml: string): boolean {
  const stack: string[] = []
  let sawRoot = false
  let position = 0
  for (const match of xhtml.matchAll(TAG_PATTERN)) {
    if (match.index !== position) {
      return false
    }
    position = match.index + match[0].length
    const token = match[0]
    if (!token.startsWith('<')) {
      // Text content: a stray '>' is fine, but only whitespace may sit outside the root.
      if (stack.length === 0 && token.trim() !== '') {
        return false
      }
      continue
    }
    if (token.startsWith('<!--') || token.startsWith('<![CDATA[')) {
      continue
    }
    const close = CLOSE_TAG.exec(token)
    if (close) {
      const name = (close[1] as string).toLowerCase()
      if (stack.pop() !== name) {
        return false
      }
      continue
    }
    const open = OPEN_TAG.exec(token)
    if (!open) {
      return false
    }
    const name = (open[1] as string).toLowerCase()
    if (!ALLOWED_ELEMENTS.has(name)) {
      return false
    }
    if (stack.length === 0) {
      if (sawRoot || name !== 'div') {
        return false
      }
      sawRoot = true
      if (!/xmlns\s*=\s*["']http:\/\/www\.w3\.org\/1999\/xhtml["']/.test(token)) {
        return false
      }
    }
    if (!validAttributes(open[2] as string)) {
      return false
    }
    const selfClosing = open[3] === '/' || VOID_ELEMENTS.has(name)
    if (!selfClosing) {
      stack.push(name)
    }
  }
  return sawRoot && stack.length === 0 && position === xhtml.length
}

function validAttributes(attributesText: string): boolean {
  for (const match of attributesText.matchAll(ATTRIBUTE)) {
    const name = (match[1] as string).toLowerCase()
    if (name.startsWith('on') || !ALLOWED_ATTRIBUTES.has(name)) {
      return false
    }
    const value = match[2]?.slice(1, -1) ?? ''
    if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(value)) {
      return false
    }
  }
  return true
}
