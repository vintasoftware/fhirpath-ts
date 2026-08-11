import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

import { analyzeExpressionDetailed } from '../src/analyzer/analyze.ts'
import { tokenize } from '../src/lexer/lexer.ts'
import type { AstNode } from '../src/parser/ast.ts'
import { parse } from '../src/parser/parser.ts'
import { r4Model } from '../src/r4/index.ts'
import { INFERENCE_SOURCE_STEP_LIMIT, INFERENCE_TOKEN_LIMIT } from '../src/typed/inference-limits.ts'
import { formatGeneratedTypeScript } from './format-generated.ts'
import { type InventoryCase, loadInferenceInventory } from './inference-corpus.ts'

type Status = 'precise' | 'opaque' | 'conflict'

interface PreparedCase {
  item: InventoryCase
  expected: string[] | undefined
  families: string[]
}

const root = fileURLToPath(new URL('..', import.meta.url))
const inferPath = `${root}/src/typed/infer.ts`
const mapsPath = `${root}/src/r4/generated/type-maps.ts`
const output = new URL('../src/typed/generated/precision-report.ts', import.meta.url)
const shardSize = 100

const distinct = new Map<string, InventoryCase>()
for (const item of loadInferenceInventory()) distinct.set(item.expression, item)

const prepared: PreparedCase[] = []
const classified: { id: string; status: 'rejected' | 'budget'; families: string[] }[] = []
for (const item of distinct.values()) {
  let ast: AstNode
  let tokens: number
  try {
    tokens = tokenize(item.expression).length - 1
    ast = parse(item.expression)
  } catch {
    classified.push({ id: item.id, status: 'rejected', families: ['syntax'] })
    continue
  }
  const families = familiesOf(ast)
  if (tokens > INFERENCE_TOKEN_LIMIT || item.expression.length > INFERENCE_SOURCE_STEP_LIMIT) {
    classified.push({ id: item.id, status: 'budget', families: [...families, 'budget'] })
    continue
  }
  const details = analyzeExpressionDetailed(item.expression, {
    model: r4Model,
    ...(item.inputType !== undefined && { inputType: item.inputType }),
  })
  prepared.push({
    item,
    expected: details.result.types?.map(normalizeTypeName),
    families,
  })
}

const statuses = new Map<string, Status>()
const temp = mkdtempSync(join(tmpdir(), 'fhirpath-inference-precision-'))
try {
  for (let offset = 0; offset < prepared.length; offset += shardSize) {
    const shard = prepared.slice(offset, offset + shardSize)
    const path = join(temp, `shard-${offset / shardSize}.ts`)
    writeFileSync(path, shardSource(shard))
    const program = ts.createProgram([path], {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
    })
    const diagnostics = ts.getPreEmitDiagnostics(program)
    if (diagnostics.length > 0) {
      const rendered = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: value => value,
        getCurrentDirectory: () => root,
        getNewLine: () => '\n',
      })
      throw new Error(`precision shard ${offset / shardSize} did not compile:\n${rendered}`)
    }
    const checker = program.getTypeChecker()
    const source = program.getSourceFile(path) as ts.SourceFile
    const aliases = new Map(source.statements.filter(ts.isTypeAliasDeclaration).map(alias => [alias.name.text, alias]))
    for (let index = 0; index < shard.length; index++) {
      const alias = aliases.get(`Status${index}`)
      if (alias === undefined) throw new Error(`missing Status${index} in shard`)
      const type = checker.getTypeAtLocation(alias)
      if (!type.isStringLiteral() || !['precise', 'opaque', 'conflict'].includes(type.value)) {
        throw new Error(`could not evaluate Status${index}: ${checker.typeToString(type)}`)
      }
      statuses.set((shard[index] as PreparedCase).item.id, type.value as Status)
    }
  }
} finally {
  rmSync(temp, { recursive: true, force: true })
}

const results = prepared.map(entry => ({
  id: entry.item.id,
  status: statuses.get(entry.item.id) as Status,
  families: entry.families,
}))
const conflicts = results.filter(result => result.status === 'conflict').map(result => result.id)
if (conflicts.length > 0) {
  throw new Error(`type-level inference is narrower than the analyzer for: ${conflicts.join(', ')}`)
}

const families = new Map<string, { total: number; precise: number; opaque: number; conflict: number }>()
for (const result of results) {
  for (const family of result.families) {
    const current = families.get(family) ?? { total: 0, precise: 0, opaque: 0, conflict: 0 }
    current.total += 1
    current[result.status] += 1
    families.set(family, current)
  }
}
const report = {
  total: distinct.size,
  checked: results.length,
  precise: results.filter(result => result.status === 'precise').length,
  opaque: results.filter(result => result.status === 'opaque').length,
  conflict: conflicts.length,
  rejected: classified.filter(result => result.status === 'rejected').length,
  budget: classified.filter(result => result.status === 'budget').length,
  families: Object.fromEntries([...families.entries()].sort(([a], [b]) => a.localeCompare(b))),
  preciseIds: results
    .filter(result => result.status === 'precise')
    .map(result => result.id)
    .sort(),
} as const

const generated =
  await formatGeneratedTypeScript(`// Generated by scripts/check-inference-precision.ts. Do not edit by hand.

export const INFERENCE_PRECISION_REPORT = ${JSON.stringify(report, null, 2)} as const
`)
if (process.argv.includes('--update')) {
  writeFileSync(output, generated)
  console.log(`wrote ${fileURLToPath(output)}`)
} else {
  const current = readFileSync(output, 'utf8')
  if (current !== generated) {
    console.error(
      `${fileURLToPath(output)} changed; run pnpm check:inference-precision --update and review the ratchet`
    )
    process.exit(1)
  }
}
console.log(`inference precision: ${report.precise} precise, ${report.opaque} opaque, ${report.conflict} conflicts`)

function shardSource(cases: PreparedCase[]): string {
  const lines = [
    `import type { FhirpathResultIn } from ${JSON.stringify(inferPath)}`,
    `import type { R4TypeOf } from ${JSON.stringify(mapsPath)}`,
    '',
    'type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false',
    'type Opaque<T extends unknown[]> = unknown extends T[number] ? true : false',
    '',
  ]
  for (let index = 0; index < cases.length; index++) {
    const entry = cases[index] as PreparedCase
    const actual = `FhirpathResultIn<${JSON.stringify(entry.item.expression)}, ${JSON.stringify(entry.item.inputType ?? 'opaque')}>`
    const expected =
      entry.expected === undefined
        ? undefined
        : `R4TypeOf[Extract<${entry.expected.map(name => JSON.stringify(name)).join(' | ') || 'never'}, keyof R4TypeOf>][]`
    lines.push(
      `type Actual${index} = ${actual}`,
      `type Status${index} = Opaque<Actual${index}> extends true ? 'opaque' : ${expected === undefined ? "'conflict'" : `Equal<Actual${index}, ${expected}> extends true ? 'precise' : 'conflict'`}`
    )
  }
  return `${lines.join('\n')}\n`
}

function normalizeTypeName(type: string): string {
  return type.startsWith('FHIR.') ? type.slice(5) : type
}

function familiesOf(root: AstNode): string[] {
  const families = new Set<string>()
  const walk = (node: AstNode): void => {
    switch (node.kind) {
      case 'null':
      case 'boolean':
      case 'string':
      case 'number':
      case 'date':
      case 'dateTime':
      case 'time':
      case 'quantity':
        families.add('literals')
        return
      case 'identifier':
        families.add('paths')
        return
      case 'external':
      case 'special':
        families.add('variables')
        return
      case 'dot':
        families.add('paths')
        walk(node.left)
        walk(node.right)
        return
      case 'indexer':
        families.add('paths')
        walk(node.target)
        walk(node.index)
        return
      case 'call':
        families.add(node.name === 'resolve' ? 'resolve' : 'functions')
        if (['where', 'select', 'all', 'repeat', 'aggregate', 'sort', 'iif'].includes(node.name))
          families.add('lambdas')
        if (node.name === 'defineVariable') families.add('variables')
        for (const argument of node.args) walk(argument)
        return
      case 'unary':
        families.add('operators')
        walk(node.operand)
        return
      case 'binary':
        families.add('operators')
        walk(node.left)
        walk(node.right)
        return
      case 'typeOp':
        families.add('operators')
        walk(node.operand)
        return
    }
  }
  walk(root)
  return [...families].sort()
}
