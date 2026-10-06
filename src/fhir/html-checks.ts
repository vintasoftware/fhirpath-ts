/**
 * FHIR narrative checking for htmlChecks() (https://hl7.org/fhir/narrative.html).
 * A narrative is XHTML: one `div` in the XHTML namespace, well-formed XML, using
 * only the elements and attributes FHIR allows, with no scripts, and with some
 * non-whitespace content: text or an image (invariant txt-2).
 *
 * The scanner accepts a strict subset of XML 1.0 and rejects everything else,
 * including DOCTYPE declarations, processing instructions, unquoted or
 * unseparated attributes, and any `&` that does not start a complete reference.
 * Comments and CDATA sections are limited to forms an HTML parser ends at the
 * same place. Inside that subset an HTML parser reads the same elements and
 * attributes, so the rules still hold when a browser renders the narrative.
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

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml'

/** Characters outside the XML 1.0 `Char` production, including lone surrogates. */
const INVALID_XML_CHAR = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u

const NAMED_REFERENCES: ReadonlyMap<string, string> = new Map([
  ['lt', '<'],
  ['gt', '>'],
  ['amp', '&'],
  ['quot', '"'],
  ['apos', "'"],
])

interface StartTag {
  name: string
  attributes: Map<string, string>
  selfClosing: boolean
  end: number
}

export function validateNarrative(xhtml: string): boolean {
  if (INVALID_XML_CHAR.test(xhtml)) {
    return false
  }
  const stack: string[] = []
  let sawRoot = false
  let hasContent = false
  let at = 0
  while (at < xhtml.length) {
    if (xhtml[at] !== '<') {
      const end = indexOrLength(xhtml, '<', at)
      const text = textContent(xhtml.slice(at, end), stack.length > 0)
      if (text === undefined) {
        return false
      }
      hasContent ||= !isXmlSpace(text)
      at = end
    } else if (xhtml.startsWith('<!--', at)) {
      const end = xhtml.indexOf('-->', at + 4)
      if (end === -1 || !validComment(xhtml.slice(at + 4, end))) {
        return false
      }
      at = end + 3
    } else if (xhtml.startsWith('<![CDATA[', at)) {
      const end = xhtml.indexOf(']]>', at + 9)
      const content = xhtml.slice(at + 9, end)
      if (end === -1 || stack.length === 0 || !validCdata(content)) {
        return false
      }
      hasContent ||= !isXmlSpace(content)
      at = end + 3
    } else if (xhtml.startsWith('</', at)) {
      const tag = scanEndTag(xhtml, at)
      if (tag === undefined || stack.pop() !== tag.name) {
        return false
      }
      at = tag.end
    } else {
      const tag = scanStartTag(xhtml, at)
      if (tag === undefined) {
        return false
      }
      if (stack.length === 0) {
        if (sawRoot || tag.name !== 'div' || tag.attributes.get('xmlns') !== XHTML_NAMESPACE) {
          return false
        }
        sawRoot = true
      }
      hasContent ||= tag.name === 'img'
      if (!tag.selfClosing) {
        stack.push(tag.name)
      }
      at = tag.end
    }
  }
  return sawRoot && stack.length === 0 && hasContent
}

/**
 * The decoded text, or undefined when it is not allowed there. Only whitespace
 * may sit outside the root, and XML forbids `]]>` in text.
 */
function textContent(text: string, insideRoot: boolean): string | undefined {
  if (!insideRoot) {
    return isXmlSpace(text) ? '' : undefined
  }
  return text.includes(']]>') ? undefined : decodeReferences(text)
}

/**
 * XML comment content may not contain `--` or end with `-`. An HTML parser also
 * ends `<!-->` and `<!--->` at once, so content may not start with `>` or `->`.
 */
function validComment(content: string): boolean {
  return !(content.startsWith('>') || content.startsWith('->') || content.includes('--') || content.endsWith('-'))
}

/** Outside SVG and MathML, an HTML parser ends CDATA at the first `>`. */
function validCdata(content: string): boolean {
  return !content.includes('>')
}

function scanStartTag(xhtml: string, start: number): StartTag | undefined {
  const name = scanName(xhtml, start + 1)
  if (!ALLOWED_ELEMENTS.has(name)) {
    return undefined
  }
  const attributes = new Map<string, string>()
  let at = start + 1 + name.length
  for (;;) {
    const separated = isXmlSpaceChar(xhtml[at])
    at = skipSpace(xhtml, at)
    if (xhtml[at] === '>') {
      return { name, attributes, selfClosing: false, end: at + 1 }
    }
    if (xhtml.startsWith('/>', at)) {
      return { name, attributes, selfClosing: true, end: at + 2 }
    }
    // Attributes must be separated by whitespace, which XML requires and HTML honors.
    if (!separated) {
      return undefined
    }
    const attributeName = scanName(xhtml, at)
    at = skipSpace(xhtml, at + attributeName.length)
    if (attributeName === '' || attributes.has(attributeName) || xhtml[at] !== '=') {
      return undefined
    }
    at = skipSpace(xhtml, at + 1)
    const quote = xhtml[at]
    const close = quote === '"' || quote === "'" ? xhtml.indexOf(quote, at + 1) : -1
    if (close === -1) {
      return undefined
    }
    const raw = xhtml.slice(at + 1, close)
    const value = raw.includes('<') ? undefined : decodeReferences(raw)
    if (value === undefined || !validAttribute(attributeName, value)) {
      return undefined
    }
    attributes.set(attributeName, value)
    at = close + 1
  }
}

function scanEndTag(xhtml: string, start: number): { name: string; end: number } | undefined {
  const name = scanName(xhtml, start + 2)
  const at = skipSpace(xhtml, start + 2 + name.length)
  return name !== '' && xhtml[at] === '>' ? { name, end: at + 1 } : undefined
}

/** Element and attribute names in the allowlists use lowercase ASCII, digits, and `:`. */
function scanName(xhtml: string, start: number): string {
  let end = start
  while (isNameChar(xhtml[end])) {
    end += 1
  }
  return xhtml.slice(start, end)
}

function isNameChar(char: string | undefined): boolean {
  return char !== undefined && ((char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') || char === ':')
}

function validAttribute(name: string, value: string): boolean {
  if (!ALLOWED_ATTRIBUTES.has(name)) {
    return false
  }
  if (name === 'xmlns') {
    return value === XHTML_NAMESPACE
  }
  if (name === 'href' || name === 'src') {
    return safeUrl(value, name)
  }
  return true
}

const SAFE_SCHEMES = new Set(['http', 'https', 'mailto', 'tel', 'ftp', 'urn', 'cid'])

/**
 * Allow only inert URL schemes: FHIR narratives may not contain scripts. A browser
 * skips control characters and spaces before it resolves the scheme, so the check
 * sees the decoded value the same way.
 */
function safeUrl(decoded: string, attributeName: string): boolean {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const value = decoded.replace(/[\u0000-\u0020]/gu, '')
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(value)
  if (!scheme) {
    // Relative URL or fragment: no scheme to smuggle code through.
    return true
  }
  const name = (scheme[1] as string).toLowerCase()
  if (attributeName === 'src' && name === 'data') {
    // Inline images are common in narratives; data: must never reach href.
    return /^data:image\//i.test(value)
  }
  return SAFE_SCHEMES.has(name)
}

/**
 * Resolve references, or return undefined when an `&` does not start a complete
 * one. XML allows only the five named references and numeric references ending
 * in `;`. A browser also decodes forms such as `&#106` without `;`, so accepting
 * them would let `&#106avascript:` pass the URL check.
 */
function decodeReferences(text: string): string | undefined {
  let decoded = ''
  let at = 0
  for (let amp = text.indexOf('&'); amp !== -1; amp = text.indexOf('&', at)) {
    const semicolon = text.indexOf(';', amp)
    const char = semicolon === -1 ? undefined : referenceValue(text.slice(amp + 1, semicolon))
    if (char === undefined) {
      return undefined
    }
    decoded += text.slice(at, amp) + char
    at = semicolon + 1
  }
  return decoded + text.slice(at)
}

function referenceValue(body: string): string | undefined {
  const named = NAMED_REFERENCES.get(body)
  if (named !== undefined) {
    return named
  }
  const hex = body.startsWith('#x')
  const digits = hex ? body.slice(2) : body.startsWith('#') ? body.slice(1) : ''
  if (!(hex ? /^[0-9a-fA-F]{1,6}$/ : /^[0-9]{1,7}$/).test(digits)) {
    return undefined
  }
  const codePoint = Number.parseInt(digits, hex ? 16 : 10)
  if (codePoint > 0x10ffff) {
    return undefined
  }
  const char = String.fromCodePoint(codePoint)
  return INVALID_XML_CHAR.test(char) ? undefined : char
}

function indexOrLength(text: string, search: string, from: number): number {
  const index = text.indexOf(search, from)
  return index === -1 ? text.length : index
}

function skipSpace(xhtml: string, start: number): number {
  let at = start
  while (isXmlSpaceChar(xhtml[at])) {
    at += 1
  }
  return at
}

/** The XML `S` production: space, tab, carriage return, and line feed. */
function isXmlSpaceChar(char: string | undefined): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r'
}

function isXmlSpace(text: string): boolean {
  return skipSpace(text, 0) === text.length
}
