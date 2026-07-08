import { Linter } from 'eslint'
import { describe, expect, it } from 'vitest'
import { findExpressionSites } from '../cli/expression-sites.ts'
import eslintPlugin from '../eslint/index.ts'

/**
 * Both walkers — the CLI (TypeScript AST) and the ESLint rule (ESTree AST) —
 * implement the same shared policy. This suite runs one corpus through both and
 * requires them to flag the same literals at the same positions, so any drift
 * in binding collection, receiver gating, or shape extraction fails here even
 * when each walker's own tests still pass.
 *
 * Every FHIRPath literal in the corpus is syntax-invalid (double dots), so each
 * checked literal yields exactly one diagnostic: the ESLint report positions are
 * then comparable one-to-one with the CLI extraction positions. The CLI records
 * the first character inside the quote; ESLint reports the literal node at the
 * quote, one column earlier.
 *
 * Why two walkers at all, instead of the ESLint rule reusing the CLI walker on
 * the raw source text: the rule must work with whatever AST the configured
 * ESLint parser produced (vue-eslint-parser SFC blocks, processor-generated
 * virtual files), and reusing the CLI walker would also make `typescript` a
 * runtime dependency of the `./eslint` export. This suite is the price of that
 * decision: parity is enforced here rather than by construction.
 */
const corpus: { name: string; code: string; expected: number }[] = [
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
      "  [computed]: 'x..7',",
      '  dynamic: someVariable,',
      '  ...spread,',
      '  shorthand,',
      '})',
      "const e = r4.checkConstraints(patient, [{ key: 'k', expression: 'x..8' }, variable, null])",
    ].join('\n'),
    expected: 8,
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
]

const linter = new Linter()

function eslintPositions(code: string): [number, number][] {
  const messages = linter.verify(code, {
    plugins: { fhirpath: eslintPlugin },
    rules: { 'fhirpath/no-invalid-expressions': 'error' },
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
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
      const cli = findExpressionSites(entry.code, 'sample.ts').map((site): [number, number] => [site.line, site.column])
      expect(cli).toHaveLength(entry.expected)
      expect(eslintPositions(entry.code)).toEqual(cli)
    })
  }
})
