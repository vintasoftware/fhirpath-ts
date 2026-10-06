import createDOMPurify from 'dompurify'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'

import { evaluate } from '../api/evaluate.ts'
import type { NarrativeSanitizer } from '../engine/context.ts'
import { FhirPathEngine } from '../index.ts'
import { r4Model } from '../r4/index.ts'
import { ALLOWED_ATTRIBUTES, ALLOWED_ELEMENTS, validateNarrative } from './html-checks.ts'
import { domPurifySanitizer } from './narrative-sanitizer.ts'

const purify = createDOMPurify(new JSDOM('').window)
const div = (body: string) => `<div xmlns="http://www.w3.org/1999/xhtml" xml:lang="en">${body}</div>`
const patient = (body: string) => ({ resourceType: 'Patient', text: { status: 'generated', div: div(body) } })

describe('narrativeSanitizer', () => {
  it('passes narratives DOMPurify keeps unchanged', () => {
    const fp = new FhirPathEngine({ model: r4Model, narrativeSanitizer: domPurifySanitizer(purify) })
    const body =
      '<p style="color:red">Hi <a href="https://example.org">link</a></p><img src="data:image/png;base64,AA" alt=""/>'
    expect(fp.evaluate('text.div.htmlChecks()', patient(body))).toEqual([true])
  })

  it('fails narratives that follow the FHIR rules but that DOMPurify changes', () => {
    const body = '<a href="urn:uuid:4f6a">entry</a>'
    expect(evaluate('text.div.htmlChecks()', patient(body), { model: r4Model })).toEqual([true])
    const sanitized = { model: r4Model, narrativeSanitizer: domPurifySanitizer(purify) }
    expect(evaluate('text.div.htmlChecks()', patient(body), sanitized)).toEqual([false])
  })

  it('merges a DOMPurify config over the default', () => {
    const body = '<a href="urn:uuid:4f6a">entry</a>'
    const sanitizer = domPurifySanitizer(purify, {
      ALLOWED_URI_REGEXP: /^(?:https?|mailto|tel|urn):|^[^a-z]|^[a-z+.-]+(?:[^a-z+.\-:]|$)/i,
    })
    expect(evaluate('text.div.htmlChecks()', patient(body), { model: r4Model, narrativeSanitizer: sanitizer })).toEqual(
      [true]
    )
  })

  it('keeps every element, attribute, and comment the FHIR rules allow', () => {
    // An HTML parser drops table parts outside a table, so they share one table.
    const table = div(
      '<table><caption>c</caption><colgroup><col/></colgroup><thead><tr><th>h</th></tr></thead>' +
        '<tbody><tr><td>t</td></tr></tbody><tfoot><tr><td>f</td></tr></tfoot></table>'
    )
    const tableParts = new Set(['table', 'caption', 'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td'])
    const elements = [...ALLOWED_ELEMENTS].map(name => ({
      narrative: tableParts.has(name)
        ? table
        : ['br', 'hr', 'img'].includes(name)
          ? div(`<${name}/>t`)
          : div(`<${name}>t</${name}>`),
      // DOMPurify always keeps tbody while table is allowed, so it cannot be forbidden.
      forbid: name === 'tbody' ? undefined : { FORBID_TAGS: [name] },
    }))
    const attributes = [...ALLOWED_ATTRIBUTES]
      .filter(name => name !== 'xmlns')
      .map(name => ({ narrative: div(`<p ${name}="1">t</p>`), forbid: { FORBID_ATTR: [name] } }))
    const sanitizer = domPurifySanitizer(purify)
    for (const { narrative, forbid } of [...elements, ...attributes]) {
      expect(validateNarrative(narrative), narrative).toBe(true)
      expect(sanitizer.accepts(narrative), narrative).toBe(true)
      // Forbidding the item must fail the narrative, so DOMPurify really saw it.
      if (forbid !== undefined) {
        expect(domPurifySanitizer(purify, forbid).accepts(narrative), JSON.stringify(forbid)).toBe(false)
      }
    }
    expect(sanitizer.accepts(div('a<!-- note -->b'))).toBe(true)
    expect(sanitizer.accepts(div('a<!-- <img src="x" onerror="x()"/> -->b'))).toBe(false)
    expect(sanitizer.accepts(div('<img src="a.png" alt="" longdesc="javascript:x()"/>'))).toBe(false)
  })

  it('sees the wrapped div for strings and runs only after the FHIR rules pass', () => {
    const seen: string[] = []
    const recorder: NarrativeSanitizer = {
      accepts: xhtml => {
        seen.push(xhtml)
        return true
      },
    }
    expect(evaluate("'<b>bold</b>'.htmlChecks()", undefined, { narrativeSanitizer: recorder })).toEqual([true])
    expect(evaluate("'<script>x()</script>'.htmlChecks()", undefined, { narrativeSanitizer: recorder })).toEqual([
      false,
    ])
    expect(seen).toEqual(['<div xmlns="http://www.w3.org/1999/xhtml"><b>bold</b></div>'])
  })
})
