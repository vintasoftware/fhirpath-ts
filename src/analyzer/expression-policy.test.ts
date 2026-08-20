import { Linter } from 'eslint'
import ts from 'typescript'
import tseslint from 'typescript-eslint'
import { describe, expect, it } from 'vitest'

import eslintPlugin from '../eslint/index.ts'
import { r4Model } from '../r4/index.ts'
import { createSiteFinder } from '../sites/index.ts'
import { analyzeSite } from './analyze.ts'
import {
  type ExpressionAst,
  expressionCandidates,
  isCheckedCall,
  optionScopes,
  type SiteVariable,
} from './expression-policy.ts'

const findExpressionSites = createSiteFinder(ts)

type MiniNode =
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'array'; values: MiniNode[] }
  | { kind: 'object'; properties: { name: string | undefined; value: MiniNode }[] }
  | { kind: 'dynamic'; label: string }

const miniAst: ExpressionAst<MiniNode> = {
  string: node => (node.kind === 'string' ? { node, expression: node.value } : undefined),
  boolean: node => (node.kind === 'boolean' ? node.value : undefined),
  properties: node => (node.kind === 'object' ? node.properties : undefined),
  elements: node => (node.kind === 'array' ? node.values : undefined),
}

const stringNode = (value: string): MiniNode => ({ kind: 'string', value })
const dynamicNode = (label: string): MiniNode => ({ kind: 'dynamic', label })
const arrayNode = (...values: MiniNode[]): MiniNode => ({ kind: 'array', values })
const objectNode = (...properties: { name: string | undefined; value: MiniNode }[]): MiniNode => ({
  kind: 'object',
  properties,
})

/**
 * Runs one invalid-expression corpus through the TypeScript and ESTree walkers.
 * Each literal produces one diagnostic, which lets the test compare positions,
 * site context, and analyzer output. The walkers stay separate because ESLint
 * must use the AST supplied by its configured parser without loading TypeScript.
 */
const corpus: { name: string; code: string; expected: number; typescript?: true }[] = [
  {
    name: 'expression-first calls and the tag',
    code: [
      'const a = fhirpath`x..1`',
      "const b = compile('x..2')",
      "const c = evaluate('x..3', input)",
      "const d = api.evaluate('x..4', input)",
      "const e = analyzeExpression('x..5')",
      "const f = r4.evaluateTyped('x..6', input)",
    ].join('\n'),
    expected: 6,
  },
  {
    name: 'engine helpers on a package-imported receiver',
    code: [
      "import { r4 } from 'fhirpath-ts/r4'",
      "const a = r4.test(patient, 'x..1')",
      "const b = r4.filter(patients, 'x..2')",
      "const c = r4.first('x..3', patient)",
      'const d = r4.project(patients, {',
      "  plain: 'x..4',",
      "  nested: { path: 'x..5', collection: true },",
      "  quoted: { 'path': 'x..6' },",
      "  criteria: { test: 'x..7' },",
      "  [computed]: 'x..8',",
      '  dynamic: someVariable,',
      '  ...spread,',
      '  shorthand,',
      '})',
      "const e = r4.checkConstraints(patient, [{ key: 'k', expression: 'x..9' }, variable, null])",
    ].join('\n'),
    expected: 9,
  },
  {
    name: 'engine helpers on a new FhirPathEngine local, used before declaration',
    code: [
      "import { FhirPathEngine } from 'fhirpath-ts'",
      "function f(p) { return engine.test(p, 'x..1') }",
      'const engine = new FhirPathEngine({})',
      "const a = engine.first('x..2', patient)",
    ].join('\n'),
    expected: 2,
  },
  {
    name: 'project columns and inline vars are both expression sites',
    code: [
      "import { r4 } from 'fhirpath-ts/r4'",
      "r4.project(input, { value: 'x..1' }, { env: { reports }, vars: { report: 'x..2' } })",
    ].join('\n'),
    expected: 2,
  },
  {
    name: 'common-name helpers without an engine binding are skipped',
    code: [
      "import knex from 'knex'",
      'const db = knex({})',
      "const a = db.first('x..1')",
      "const b = db.filter(rows, 'x..2')",
      "const c = validator.test(input, 'x..3')",
      "const d = this.engine.filter(patients, 'x..4')",
      "const e = r4.project(patients, { col: 'x..5' })",
    ].join('\n'),
    expected: 0,
  },
  {
    name: 'foreign imports are skipped, package imports are checked',
    code: [
      "import Handlebars, { compile } from 'handlebars'",
      "import fhirpath from 'other-lib'",
      "import { evaluate } from 'fhirpath-ts'",
      "const a = compile('x..1')",
      'const b = fhirpath`x..2`',
      "const c = evaluate('x..3', input)",
      "const d = Handlebars.compile('x..4')",
      "const e = Unbound.compile('x..5')", // an unbound receiver root does not make a distinctive name foreign
    ].join('\n'),
    expected: 2,
  },
  {
    name: 'namespace imports bind like named imports',
    code: [
      "import * as fp from 'fhirpath-ts/r4'",
      "import * as Handlebars from 'handlebars'",
      "const a = fp.r4.filter(patients, 'x..1')", // package namespace root is an engine binding
      "const b = Handlebars.compile('x..2')", // foreign namespace root is foreign
    ].join('\n'),
    expected: 1,
  },
  {
    name: 'callees without a static name are skipped',
    code: [
      "const a = arr[0]('x..1')",
      "const b = obj[method](patient, 'x..2')",
      "const c = getEngine().evaluate('x..3', input)", // deep root is fine for receiver:any names
    ].join('\n'),
    expected: 1,
  },
  {
    name: 'trusted names re-bound in the file are demoted',
    code: [
      "import { r4 } from 'fhirpath-ts/r4'",
      "import * as fp from 'fhirpath-ts/r4'",
      "import { FhirPathEngine } from 'fhirpath-ts'",
      "function query(r4) { return r4.filter(rows, 'x..1') }", // parameter shadows the import
      'const engine = new FhirPathEngine({})',
      "function b(engine) { return engine.filter(rows, 'x..2') }", // parameter shadows the engine local
      "function c({ fp }) { return fp.r4.filter(rows, 'x..3') }", // destructured parameter shadows the namespace
      'const still = new FhirPathEngine({})',
      "const ok = still.test(patient, 'x..4')", // demotion does not spread to other trusted names
    ].join('\n'),
    expected: 1,
  },
  {
    // A namespace import reaches the API through a member access, and every place
    // that resolves a name must read it the same way. These two shapes are why:
    // the tag and the `extends` clause each used to be checked with their own
    // Identifier-only test in the rule, so both went unreported there while
    // `fhirpath-ts/sites` reported them.
    name: 'names reached through a namespace import',
    code: [
      "import * as api from 'fhirpath-ts'",
      'const a = api.fhirpath`x..1`',
      "const b = api.compile('x..2')",
      // Not a third site: `defineDto` is `receiver: 'import'`, which asks for the
      // callee name itself to be the imported one, so a member-access callee is
      // not a checked call and its `vars` go unread — in both walkers. The root
      // this clause fixes is still read from it (see the context suite below).
      "class Row extends api.defineDto('Condition', { vars: { v: 'x..3' } }) {}",
    ].join('\n'),
    expected: 2,
    typescript: true,
  },
  {
    // A tag is gated on its receiver like a call: only the last of these is ours.
    // The rule and the finder each used to decide this alone, and neither looked
    // at the receiver.
    name: 'tags are gated on the name they are reached through',
    code: [
      "import * as hb from 'handlebars'",
      "import { compile } from 'handlebars'",
      'const a = hb.fhirpath`x..1`',
      "const b = hb.compile('x..2')",
      'const c = fhirpath`x..3`',
    ].join('\n'),
    expected: 1,
  },
  {
    name: 'DTO declarations: column, criteria and vars',
    code: [
      "import { column, criteria, defineDto } from 'fhirpath-ts'",
      "class Row extends defineDto('Condition', { vars: { badge: 'x..1' } }) {",
      "  @column('x..2', { type: 'string' }) name!: string | undefined",
      "  @column('x..3', { collection: true }) all!: unknown[]",
      "  @criteria('x..4') flag!: boolean",
      '}',
    ].join('\n'),
    expected: 4,
    typescript: true,
  },
  {
    // No statically-known root, so `analyzeSite` keeps syntax findings only — the
    // corpus is all syntax errors, so both walkers must still report every one.
    name: 'DTO declarations on a class with no statically-known root',
    code: [
      "import { column, criteria } from 'fhirpath-ts'",
      "class Row extends badgedRow('DiagnosticReport') {",
      "  @column('x..1') name!: unknown",
      "  @criteria('x..2') flag!: boolean",
      '}',
    ].join('\n'),
    expected: 2,
    typescript: true,
  },
  {
    name: 'the DTO vocabulary is skipped when it is not the package export',
    code: [
      'const column = (path: string) => path',
      "class Row extends defineDto('Condition') {",
      "  @column('x..1') name!: unknown",
      '}',
    ].join('\n'),
    expected: 0,
    typescript: true,
  },
]

const linter = new Linter()

describe('literal call context extraction', () => {
  it('keeps semantic engine evidence inside the shared receiver policy', () => {
    const bindings = { foreign: new Set<string>(), trusted: new Set<string>(), rebound: new Set<string>() }
    expect(
      isCheckedCall({ argIndex: 0, shape: 'expression', receiver: 'engine' }, 'first', 'fp', bindings, { engine: true })
    ).toBe(true)
    expect(
      isCheckedCall({ argIndex: 0, shape: 'expression', receiver: 'any' }, 'evaluate', 'fp', bindings, { engine: true })
    ).toBe(true)
    expect(
      isCheckedCall({ argIndex: 0, shape: 'expression', receiver: 'import' }, 'column', 'fp', bindings, {
        engine: true,
      })
    ).toBe(false)
  })

  it('reads names and complete type declarations from EvaluateOptions', () => {
    const patient: SiteVariable = { types: ['Patient'], single: false, targets: ['Organization'] }
    const options = objectNode(
      {
        name: 'env',
        value: objectNode(
          { name: '%plain', value: dynamicNode('plain') },
          { name: undefined, value: dynamicNode('computed') }
        ),
      },
      {
        name: 'envTypes',
        value: objectNode(
          {
            name: 'patient',
            value: objectNode(
              { name: 'type', value: stringNode('Patient') },
              { name: 'collection', value: { kind: 'boolean', value: true } },
              { name: 'targets', value: stringNode('Organization') }
            ),
          },
          {
            name: 'choice',
            value: objectNode(
              { name: 'type', value: arrayNode(stringNode('Condition'), stringNode('Observation')) },
              { name: 'collection', value: { kind: 'boolean', value: false } },
              { name: 'targets', value: arrayNode(stringNode('Patient'), stringNode('Organization')) }
            ),
          },
          { name: 'invalid', value: dynamicNode('invalid declaration') },
          {
            name: 'ambiguous',
            value: objectNode(
              { name: 'type', value: stringNode('Patient') },
              { name: 'collection', value: dynamicNode('collection') },
              { name: 'targets', value: arrayNode(stringNode('Patient'), dynamicNode('target')) }
            ),
          },
          {
            name: 'partlyDynamic',
            value: objectNode({ name: 'type', value: arrayNode(stringNode('Condition'), dynamicNode('type')) }),
          },
          { name: 'missingType', value: objectNode({ name: 'collection', value: { kind: 'boolean', value: true } }) },
          { name: undefined, value: objectNode({ name: 'type', value: stringNode('Observation') }) }
        ),
      },
      { name: 'vars', value: objectNode({ name: 'row', value: stringNode('%plain') }) },
      {
        name: 'varTypes',
        value: objectNode({ name: 'row', value: objectNode({ name: 'type', value: stringNode('Observation') }) }),
      }
    )

    const scopes = optionScopes(options, miniAst)
    expect(scopes?.env).toEqual({
      plain: {},
      patient,
      choice: {
        types: ['Condition', 'Observation'],
        single: true,
        targets: ['Patient', 'Organization'],
      },
      ambiguous: { types: ['Patient'] },
    })
    expect(scopes?.vars).toEqual({
      row: { types: ['Observation'], single: true },
    })
    expect(scopes?.expressions).toEqual([{ node: stringNode('%plain'), name: 'row', expression: '%plain' }])
    expect(optionScopes(dynamicNode('options'), miniAst)).toBeUndefined()
  })

  it('identifies static and unread nodes in every supported expression container', () => {
    const dynamic = dynamicNode('dynamic')
    expect(expressionCandidates(dynamic, 'expression', miniAst)).toEqual([{ node: dynamic }])
    const literal = stringNode('ok')
    expect(expressionCandidates(literal, 'expression', miniAst)).toEqual([{ node: literal, expression: 'ok' }])

    const columns = objectNode(
      { name: 'literal', value: stringNode('Patient.name') },
      { name: 'dynamic', value: dynamic },
      { name: 'nested', value: objectNode({ name: 'path', value: dynamic }, { name: 'test', value: stringNode('ok') }) }
    )
    expect(expressionCandidates(columns, 'columns', miniAst)).toEqual([
      { node: expect.objectContaining({ kind: 'string' }), expression: 'Patient.name' },
      { node: dynamic },
      { node: dynamic },
      { node: expect.objectContaining({ kind: 'string' }), expression: 'ok' },
    ])
    expect(expressionCandidates(dynamic, 'columns', miniAst)).toEqual([])

    const vars = objectNode({ name: 'vars', value: objectNode({ name: 'a', value: dynamic }) })
    expect(expressionCandidates(vars, 'dto-vars', miniAst)).toEqual([{ node: dynamic }])
    const dynamicVars = objectNode({ name: 'vars', value: dynamic })
    expect(expressionCandidates(dynamicVars, 'dto-vars', miniAst)).toEqual([{ node: dynamic }])

    expect(expressionCandidates(dynamic, 'constraints', miniAst)).toEqual([{ node: dynamic }])
    const constraints = arrayNode(
      dynamic,
      objectNode({ name: 'expression', value: dynamic }),
      objectNode({ name: 'expression', value: stringNode('ok') })
    )
    expect(expressionCandidates(constraints, 'constraints', miniAst)).toEqual([
      { node: dynamic },
      { node: dynamic },
      { node: expect.objectContaining({ kind: 'string' }), expression: 'ok' },
    ])
  })
})

function eslintPositions(code: string, typescript: boolean): [number, number][] {
  const messages = linter.verify(code, {
    plugins: { fhirpath: eslintPlugin },
    rules: { 'fhirpath/no-invalid-expressions': 'error' },
    // DTO fields carry decorators and type annotations, which the default parser
    // cannot read — the same TypeScript parser the repo lints with supplies them.
    languageOptions: typescript
      ? { parser: tseslint.parser as Linter.Parser, ecmaVersion: 2022, sourceType: 'module' }
      : { ecmaVersion: 2022, sourceType: 'module' },
  })
  for (const message of messages) {
    // Only rule reports count; a parse error would silently zero the corpus entry.
    expect(message.ruleId).toBe('fhirpath/no-invalid-expressions')
  }
  return messages.map(message => [message.line, message.column + 1])
}

describe('CLI and ESLint walkers stay in lockstep', () => {
  for (const entry of corpus) {
    it(entry.name, () => {
      const sites = findExpressionSites(entry.code, 'sample.ts')
      const cli = sites.map((site): [number, number] => [site.line, site.column])
      expect(cli).toHaveLength(entry.expected)
      expect(eslintPositions(entry.code, entry.typescript === true)).toEqual(cli)
    })
  }
})

/**
 * The two walkers must also agree on each site's *context*, not only on where the
 * sites are: the DTO root and the column vocabulary decide which findings survive
 * `analyzeSite`, so a walker that reads the root differently reports different
 * diagnostics from identical source. Positions alone would not catch that — both
 * report a syntax error with or without a root — so this compares the diagnostics
 * themselves over valid-syntax expressions whose errors are root-dependent.
 */
describe('the walkers agree on a site’s context', () => {
  const cases: { name: string; code: string; expected: string[] }[] = [
    {
      name: 'a column path resolves against the class fhirType',
      code: [
        "import { column, defineDto } from 'fhirpath-ts'",
        "class Row extends defineDto('Condition') {",
        "  @column('clinicalStatus.codingg.first().code') code!: string | undefined",
        '}',
      ].join('\n'),
      expected: ["unknown-element: Element 'codingg' is not defined on FHIR.CodeableConcept — did you mean 'coding'?"],
    },
    {
      name: 'a namespace-imported defineDto still fixes the root',
      code: [
        "import * as api from 'fhirpath-ts'",
        "import { column } from 'fhirpath-ts'",
        "class Row extends api.defineDto('Condition') {",
        "  @column('clinicalStatus.codingg.first().code') code!: string | undefined",
        '}',
      ].join('\n'),
      expected: ["unknown-element: Element 'codingg' is not defined on FHIR.CodeableConcept — did you mean 'coding'?"],
    },
    {
      name: 'a %var on a DTO site is never judged',
      code: [
        "import { column, defineDto } from 'fhirpath-ts'",
        "class Row extends defineDto('Condition') {",
        "  @column('%whatever.label') label!: unknown",
        '}',
      ].join('\n'),
      expected: [],
    },
    {
      name: 'project vars see env, row values, and only earlier vars',
      code: [
        "import { r4 } from 'fhirpath-ts/r4'",
        "r4.project(rows, { value: '%later' }, {",
        '  env: { external },',
        '  vars: {',
        "    first: '%external.combine(%rowIndex)',",
        "    second: '%first',",
        "    premature: '%later',",
        "    later: '%second.combine(%rowTotal)',",
        '  },',
        '})',
      ].join('\n'),
      expected: ['unknown-variable: Undefined environment variable %later'],
    },
    {
      name: 'ordinary call vars see env and only earlier vars',
      code: [
        "import { r4 } from 'fhirpath-ts/r4'",
        "r4.evaluate('%later', patient, {",
        '  env: { external },',
        '  vars: {',
        "    first: '%external',",
        "    second: '%first',",
        "    premature: '%later',",
        "    later: '%second',",
        '  },',
        '})',
      ].join('\n'),
      expected: ['unknown-variable: Undefined environment variable %later'],
    },
    {
      name: 'a call into a column the same file declares resolves, and carries its type',
      code: [
        "import { column, defineDto } from 'fhirpath-ts'",
        "class Concept extends defineDto('CodeableConcept') {",
        "  @column('text', { type: 'string' }) displayText!: string | undefined",
        '}',
        "class Row extends defineDto('Condition') {",
        "  @column('code.displayText().length()') len!: number | undefined",
        '}',
      ].join('\n'),
      expected: [],
    },
    {
      name: 'a near-miss of a column the same file declares is still a typo',
      code: [
        "import { column, defineDto } from 'fhirpath-ts'",
        "class Concept extends defineDto('CodeableConcept') {",
        "  @column('text', { type: 'string' }) displayText!: string | undefined",
        '}',
        "class Row extends defineDto('Condition') {",
        "  @column('code.displayTxt()') name!: unknown",
        '}',
      ].join('\n'),
      expected: ["unknown-function: Unrecognized function 'displayTxt' — did you mean 'displayText'?"],
    },
    {
      name: 'a root followed through a same-file base class',
      code: [
        "import { column, defineDto } from 'fhirpath-ts'",
        "class Base extends defineDto('Observation') {",
        "  @column('issued') at!: unknown",
        '}',
        'class Sub extends Base {',
        "  @column('valuee.ofType(Quantity).value') kg!: unknown",
        '}',
      ].join('\n'),
      expected: ["unknown-element: Element 'valuee' is not defined on FHIR.Observation — did you mean 'value'?"],
    },
    {
      name: 'a column called on a focus that can never hold its own fhirType',
      code: [
        "import { column, defineDto } from 'fhirpath-ts'",
        "class Concept extends defineDto('CodeableConcept') {",
        "  @column('text', { type: 'string' }) displayText!: string | undefined",
        '}',
        "class Row extends defineDto('Condition') {",
        "  @column('subject.reference.displayText()') name!: unknown",
        '}',
      ].join('\n'),
      expected: ['input-type: displayText() expects FHIR.CodeableConcept as input, found FHIR.string'],
    },
    {
      name: 'a column whose cardinality is dynamic still declares what it is written against',
      code: [
        "import { column, defineDto } from 'fhirpath-ts'",
        "class Concept extends defineDto('CodeableConcept') {",
        "  @column('coding.display', { collection: dynamic }) displays!: string[]",
        '}',
        "class Row extends defineDto('Condition') {",
        "  @column('subject.reference.displays()') name!: unknown",
        '}',
      ].join('\n'),
      expected: ['input-type: displays() expects FHIR.CodeableConcept as input, found FHIR.string'],
    },
    {
      name: 'a column whose own root comes from a base class declared below it',
      // Sub's fhirType is only known once Base is read, so the walkers must
      // decide the file's column vocabulary after the whole file, not during it.
      code: [
        "import { column, defineDto } from 'fhirpath-ts'",
        'class Sub extends Base {',
        "  @column('text', { type: 'string' }) displayText!: string | undefined",
        '}',
        "class Base extends defineDto('CodeableConcept') {",
        "  @column('id') conceptId!: unknown",
        '}',
        "class Row extends defineDto('Condition') {",
        "  @column('subject.reference.displayText()') name!: unknown",
        '}',
      ].join('\n'),
      expected: ['input-type: displayText() expects FHIR.CodeableConcept as input, found FHIR.string'],
    },
    {
      name: 'one field name declared against two roots resolves by the focus',
      // Both `label`s can register on one engine, scoped by the type each was
      // written for, and `code` is a CodeableConcept. Keeping the last one seen
      // would report this valid call.
      code: [
        "import { column, defineDto } from 'fhirpath-ts'",
        "class ConceptRow extends defineDto('CodeableConcept') {",
        "  @column('text', { type: 'string' }) label!: string | undefined",
        '}',
        "class CodingRow extends defineDto('Coding') {",
        "  @column('display', { type: 'string' }) label!: string | undefined",
        '}',
        "class ProblemRow extends defineDto('Condition') {",
        "  @column('code.label()') name!: unknown",
        '}',
      ].join('\n'),
      expected: [],
    },
    {
      // Two `label`s the focus cannot tell apart: the call keeps only what they
      // agree on, which about the result is nothing.
      name: 'one field name declared with two result types claims neither',
      code: [
        "import { column, defineDto } from 'fhirpath-ts'",
        "class Text extends defineDto('CodeableConcept') {",
        "  @column('text', { type: 'string' }) label!: string | undefined",
        '}',
        "class Count extends defineDto('CodeableConcept') {",
        "  @column('coding.count()', { type: 'integer' }) label!: number | undefined",
        '}',
        "class ProblemRow extends defineDto('Condition') {",
        "  @column('code.label().length()') n!: unknown",
        '}',
      ].join('\n'),
      expected: [],
    },
    {
      name: 'a field name declared against two roots is checked against the one the focus fits',
      // The precision an overload set buys: the two `label`s disagree about
      // everything, and each call still gets the result of the column its own
      // focus reaches.
      code: [
        "import { column, defineDto } from 'fhirpath-ts'",
        "class ConceptRow extends defineDto('CodeableConcept') {",
        "  @column('coding.count()', { type: 'integer' }) label!: number | undefined",
        '}',
        "class CodingRow extends defineDto('Coding') {",
        "  @column('display', { type: 'string' }) label!: string | undefined",
        '}',
        "class ProblemRow extends defineDto('Condition') {",
        "  @column('code.coding.label().length()') chars!: unknown",
        "  @column('code.label().length()') counted!: unknown",
        '}',
      ].join('\n'),
      expected: ['operand-type: length() expects a String input, found FHIR.integer'],
    },
    {
      name: 'a field name shared with a rootless declaration keeps no claim at all',
      // The rootless `label` answers every call, so the pair claims nothing
      // wherever both are in play — the Integer result of the one whose root is
      // known cannot be pinned on this call.
      code: [
        "import { column, defineDto } from 'fhirpath-ts'",
        "class Loose extends keyedRow('CodeableConcept') {",
        "  @column('coding.first().display', { type: 'string' }) label!: string | undefined",
        '}',
        "class Concept extends defineDto('CodeableConcept') {",
        "  @column('coding.count()', { type: 'integer' }) label!: number | undefined",
        '}',
        "class ProblemRow extends defineDto('Condition') {",
        "  @column('code.label().length()') n!: unknown",
        '}',
      ].join('\n'),
      expected: [],
    },
    {
      name: 'declarations that disagree on the result still declare the input they share',
      // A focus none of them accepts is reported against all of them at once.
      // Both `label`s are written against a CodeableConcept, so a call on a
      // string focus is wrong whichever one it meant — dropping the signature
      // of a name declared twice would miss it.
      code: [
        "import { column, defineDto } from 'fhirpath-ts'",
        "class Text extends defineDto('CodeableConcept') {",
        "  @column('text', { type: 'string' }) label!: string | undefined",
        '}',
        "class Count extends defineDto('CodeableConcept') {",
        "  @column('coding.count()', { type: 'integer' }) label!: number | undefined",
        '}',
        "class ProblemRow extends defineDto('Condition') {",
        "  @column('subject.reference.label()') name!: unknown",
        '}',
      ].join('\n'),
      expected: ['input-type: label() expects FHIR.CodeableConcept as input, found FHIR.string'],
    },
    {
      name: 'agreeing declarations of one field name keep their claims',
      // Same name, same root, same result — nothing is in doubt, so the wrong
      // focus is still reported.
      code: [
        "import { column, defineDto } from 'fhirpath-ts'",
        "class A extends defineDto('CodeableConcept') {",
        "  @column('text', { type: 'string' }) label!: string | undefined",
        '}',
        "class B extends defineDto('CodeableConcept') {",
        "  @column('coding.first().display', { type: 'string' }) label!: string | undefined",
        '}',
        "class ProblemRow extends defineDto('Condition') {",
        "  @column('subject.reference.label()') name!: unknown",
        '}',
      ].join('\n'),
      expected: ['input-type: label() expects FHIR.CodeableConcept as input, found FHIR.string'],
    },
    {
      name: 'a column on a root-generic factory declares no input, so calls stay unchecked',
      code: [
        "import { column, defineDto } from 'fhirpath-ts'",
        "class Concept extends keyedRow('CodeableConcept') {",
        "  @column('text', { type: 'string' }) displayText!: string | undefined",
        '}',
        "class Row extends defineDto('Condition') {",
        "  @column('subject.reference.displayText()') name!: unknown",
        '}',
      ].join('\n'),
      expected: [],
    },
    {
      name: 'no statically-known root keeps syntax findings only',
      code: [
        "import { column } from 'fhirpath-ts'",
        "class Row extends badgedRow('DiagnosticReport') {",
        "  @column('clinicalStatus.codingg.first()') code!: unknown",
        '}',
      ].join('\n'),
      expected: [],
    },
  ]

  for (const entry of cases) {
    it(entry.name, () => {
      const fromSites = findExpressionSites(entry.code, 'sample.ts').flatMap(site =>
        analyzeSite(site, { model: r4Model })
          // The rule can only report errors (ESLint severity is per-rule), so
          // comparing its output to anything else would fail on a warning-level
          // finding — a corpus entry provoking `regex-backtracking`, say — that
          // both walkers agree on.
          .filter(diagnostic => diagnostic.severity === 'error')
          .map(diagnostic => `${diagnostic.code}: ${diagnostic.message}`)
      )
      expect(fromSites).toEqual(entry.expected)
      expect(eslintMessages(entry.code)).toEqual(entry.expected)
    })
  }
})

/**
 * The rule's reports, stripped of position, in the same shape as an analyzer
 * diagnostic. Error severity only, which is all the rule can produce — see the
 * filter on the sites side.
 */
function eslintMessages(code: string): string[] {
  return linter
    .verify(code, {
      plugins: { fhirpath: eslintPlugin },
      rules: { 'fhirpath/no-invalid-expressions': 'error' },
      languageOptions: { parser: tseslint.parser as Linter.Parser, ecmaVersion: 2022, sourceType: 'module' },
    })
    .map(message => message.message.replace(/^\[([^\]]+)] /, '$1: '))
}
