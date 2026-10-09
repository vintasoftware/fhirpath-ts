import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { skipReason } from '../src/testing/fhirpathjs-harness.ts'

interface OfficialTest {
  name: string
  expression: string
  invalid?: string
  inputfile?: string
}

interface OfficialGroup {
  name: string
  tests: OfficialTest[]
}

interface CorpusTest {
  expression: string | string[] | object
  error?: boolean | boolean[]
  disable?: boolean
  inheritedDisable?: boolean
  model?: string
  inputfile?: string
}

interface CorpusFile {
  subject?: unknown
  tests: CorpusTest[]
}

export interface InventoryCase {
  id: string
  expression: string
  source: 'official-r4' | 'official-r5' | 'fhirpathjs' | 'fhirpath-py'
  inputType?: string
  reference:
    | { kind: 'official'; suite: 'r4' | 'r5'; groupIndex: number; testIndex: number }
    | {
        kind: 'fhirpathjs'
        corpus: 'cases' | 'cases-py-extras'
        file: string
        testIndex: number
        expressionIndex: number
      }
}

const root = fileURLToPath(new URL('..', import.meta.url))
const data = (relative: string): unknown => JSON.parse(readFileSync(`${root}/test-data/${relative}`, 'utf8'))

/** Runnable, valid reference cases used as the type-inference expression inventory. */
export function loadInferenceInventory(): InventoryCase[] {
  const cases: InventoryCase[] = []
  for (const suite of ['r4', 'r5'] as const) {
    const groups = data(`official/${suite}/tests.json`) as OfficialGroup[]
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
      const group = groups[groupIndex] as OfficialGroup
      for (let index = 0; index < group.tests.length; index++) {
        const test = group.tests[index] as OfficialTest
        if (test.invalid === undefined) {
          const inputType = resourceType(
            test.inputfile === undefined
              ? undefined
              : `official/${suite}/fixtures/${test.inputfile.replace(/\.xml$/, '.json')}`
          )
          cases.push({
            id: `official:${suite}:${group.name}:${test.name || index}`,
            expression: test.expression,
            source: `official-${suite}`,
            reference: { kind: 'official', suite, groupIndex, testIndex: index },
            ...(inputType !== undefined && { inputType }),
          })
        }
      }
    }
  }
  for (const [name, source] of [
    ['cases', 'fhirpathjs'],
    ['cases-py-extras', 'fhirpath-py'],
  ] as const) {
    const corpus = data(`fhirpathjs/${name}.json`) as Record<string, CorpusFile>
    for (const [file, content] of Object.entries(corpus)) {
      for (let testIndex = 0; testIndex < content.tests.length; testIndex++) {
        const test = content.tests[testIndex] as CorpusTest
        const expressions =
          typeof test.expression === 'string'
            ? [test.expression]
            : Array.isArray(test.expression)
              ? test.expression.filter((entry): entry is string => typeof entry === 'string')
              : []
        for (let expressionIndex = 0; expressionIndex < expressions.length; expressionIndex++) {
          const expression = expressions[expressionIndex] as string
          if (skipReason(test, expression, file) !== undefined) continue
          const inputType =
            resourceType(test.inputfile === undefined ? undefined : `fhirpathjs/resources/${test.inputfile}`) ??
            resourceTypeOf(test.inputfile === undefined ? content.subject : undefined)
          cases.push({
            id: `${source}:${file}:${testIndex}:${expressionIndex}`,
            expression,
            source,
            reference: {
              kind: 'fhirpathjs',
              corpus: name,
              file,
              testIndex,
              expressionIndex,
            },
            ...(inputType !== undefined && { inputType }),
          })
        }
      }
    }
  }
  return cases
}

function resourceType(path: string | undefined): string | undefined {
  if (path === undefined) return undefined
  try {
    return resourceTypeOf(data(path))
  } catch {
    return undefined
  }
}

function resourceTypeOf(value: unknown): string | undefined {
  const type = (value as { resourceType?: unknown } | undefined)?.resourceType
  return typeof type === 'string' ? type : undefined
}
