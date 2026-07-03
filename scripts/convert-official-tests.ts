/**
 * Converts the vendored official FHIRPath test suites (fhir-test-cases XML) to the
 * committed JSON the vitest harness runs. Preserves groups, invalid/predicate/mode
 * attributes, and multiple outputs.
 *
 * Run from packages/fhirpath: node scripts/convert-official-tests.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { XMLParser } from 'fast-xml-parser'

export interface OfficialOutput {
  type: string
  value: string
}

export interface OfficialTest {
  name: string
  inputfile?: string
  expression: string
  invalid?: string
  predicate?: boolean
  mode?: string
  outputs: OfficialOutput[]
}

export interface OfficialGroup {
  name: string
  description?: string
  tests: OfficialTest[]
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
})

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return []
  }
  return Array.isArray(value) ? value : [value]
}

function textOf(node: unknown): string {
  if (typeof node === 'string') {
    return node
  }
  if (typeof node === 'object' && node !== null) {
    const text = (node as Record<string, unknown>)['#text']
    return text === undefined ? '' : String(text)
  }
  return String(node)
}

function convert(release: 'r4' | 'r5'): void {
  const directory = resolve(import.meta.dirname, '../test-data/official', release)
  const xml = readFileSync(resolve(directory, `tests-fhir-${release}.xml`), 'utf8')
  const document = parser.parse(xml) as { tests: { group: unknown } }
  const groups: OfficialGroup[] = []
  let testCount = 0
  interface ParsedNode {
    test?: unknown
    expression?: unknown
    output?: unknown
    [key: `@_${string}`]: unknown
  }
  for (const groupNode of asArray(document.tests.group) as ParsedNode[]) {
    const group: OfficialGroup = {
      name: String(groupNode['@_name'] ?? ''),
      tests: [],
    }
    if (groupNode['@_description'] !== undefined) {
      group.description = String(groupNode['@_description'])
    }
    for (const testNode of asArray(groupNode.test) as ParsedNode[]) {
      const expressionNode = testNode.expression
      const test: OfficialTest = {
        name: String(testNode['@_name'] ?? `${group.name}-${group.tests.length + 1}`),
        expression: textOf(expressionNode),
        outputs: [],
      }
      if (testNode['@_inputfile'] !== undefined) {
        test.inputfile = String(testNode['@_inputfile'])
      }
      if (testNode['@_predicate'] === 'true') {
        test.predicate = true
      }
      if (testNode['@_mode'] !== undefined) {
        test.mode = String(testNode['@_mode'])
      }
      const invalid =
        typeof expressionNode === 'object' && expressionNode !== null
          ? (expressionNode as Record<string, unknown>)['@_invalid']
          : undefined
      if (invalid !== undefined) {
        test.invalid = String(invalid)
      }
      for (const outputNode of asArray(testNode.output)) {
        test.outputs.push({
          type: String((outputNode as Record<string, unknown>)['@_type'] ?? ''),
          value: textOf(outputNode),
        })
      }
      group.tests.push(test)
      testCount += 1
    }
    groups.push(group)
  }
  writeFileSync(resolve(directory, 'tests.json'), `${JSON.stringify(groups, null, 2)}\n`)
  console.log(`wrote ${release}/tests.json: ${groups.length} groups, ${testCount} tests`)
}

convert('r4')
convert('r5')
