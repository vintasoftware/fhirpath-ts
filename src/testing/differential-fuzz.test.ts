import { readFileSync } from 'node:fs'

import fc from 'fast-check'
import fhirpathjs from 'fhirpath'
import fhirpathjsR4Model from 'fhirpath/fhir-context/r4'
import { describe, expect, it } from 'vitest'

import { evaluate } from '../index.ts'
import { r4Model } from '../r4/index.ts'
import { testDataPath } from './test-data.ts'

/**
 * Differential fuzzing against fhirpath.js (the HL7 reference JS engine):
 * generated expressions run on both engines over the official patient fixture
 * and must agree. The generator deliberately stays inside the semantics both
 * engines implement identically — integer arithmetic (no '/', which is
 * float-vs-exact-decimal territory, and no results outside the 32-bit range,
 * where this engine widens Integer to Long/Decimal while fhirpath.js keeps a JS
 * float — different representations that JSON can't even compare, since Long is
 * a bigint; see the integer generator below), string functions, boolean logic,
 * navigation, and collection functions — so any disagreement is a bug, not a
 * documented quirk (those live in test-data/fhirpathjs/quirk-manifest.ts).
 */

const patient = JSON.parse(readFileSync(testDataPath('official/r4/fixtures/patient-example.json'), 'utf8')) as object

// Collection-valued paths on the fixture, mixing present and absent elements.
const COLLECTION_PATHS = [
  'name.given',
  'name.family',
  'name.use',
  'telecom.value',
  'address.city',
  'address.line',
  'identifier.value',
  'contact.name.given',
  'communication.language.text',
]

const STRING_LITERALS = ['official', 'Chalmers', 'x', '', 'home phone', "it's"]

const stringCollectionArb = fc.constantFrom(...COLLECTION_PATHS)

// FHIRPath's Integer is 32-bit signed. Past that range this engine widens the
// result to Long (a bigint) or Decimal, while fhirpath.js keeps a JS float —
// values that JSON.stringify can't even compare (it throws on bigint). That is a
// genuine divergence, so the integer generator stays inside the shared range by
// construction — each node carries the value it evaluates to (empty === undefined,
// which both engines agree on and which propagates harmlessly), and any concrete
// result outside the 32-bit range is rejected before it can reach the assertion.
const INTEGER_MIN = -2147483648
const INTEGER_MAX = 2147483647

interface IntExpr {
  expr: string
  value: number | undefined
}

// Exact count() of each collection path on the fixture, so the generator knows
// the true value of a `path.count()` leaf. count() is unambiguous across engines.
const PATH_COUNTS: Record<string, number> = Object.fromEntries(
  COLLECTION_PATHS.map(path => [path, theirs(`${path}.count()`)[0] as number])
)

function applyIntOp(left: number | undefined, operator: string, right: number | undefined): number | undefined {
  if (left === undefined || right === undefined) {
    return undefined
  }
  switch (operator) {
    case '+':
      return left + right
    case '-':
      return left - right
    case '*':
      return left * right
    case 'div':
      return right === 0 ? undefined : Math.trunc(left / right)
    case 'mod':
      return right === 0 ? undefined : left % right
    default:
      return undefined
  }
}

const overflows = (value: number | undefined): boolean =>
  value !== undefined && (value < INTEGER_MIN || value > INTEGER_MAX)

const intExprArb: fc.Arbitrary<IntExpr> = fc.letrec<{ int: IntExpr }>(tie => ({
  int: fc.oneof(
    { depthSize: 'small' },
    fc.integer({ min: 0, max: 1000 }).map(n => ({ expr: String(n), value: n })),
    fc.integer({ min: 0, max: 1000 }).map(n => ({ expr: String(n), value: n })),
    stringCollectionArb.map(path => ({ expr: `${path}.count()`, value: PATH_COUNTS[path] })),
    fc
      .tuple(tie('int'), fc.constantFrom('+', '-', '*', 'div', 'mod'), tie('int'))
      .map(([left, operator, right]) => ({
        expr: `(${left.expr} ${operator} ${right.expr})`,
        value: applyIntOp(left.value, operator, right.value),
      }))
      .filter(node => !overflows(node.value))
  ),
})).int

const intArb: fc.Arbitrary<string> = intExprArb.map(node => node.expr)

const stringArb: fc.Arbitrary<string> = fc.letrec<{ str: string }>(tie => ({
  str: fc.oneof(
    { depthSize: 'small' },
    fc.constantFrom(...STRING_LITERALS).map(text => `'${text.replace(/'/g, "\\'")}'`),
    stringCollectionArb.map(path => `${path}.first()`),
    fc.tuple(tie('str'), tie('str')).map(([left, right]) => `(${left} & ${right})`),
    tie('str').map(value => `${value}.upper()`),
    tie('str').map(value => `${value}.lower()`),
    fc.tuple(tie('str'), fc.integer({ min: 0, max: 5 })).map(([value, start]) => `${value}.substring(${start})`)
  ),
})).str

const boolArb: fc.Arbitrary<string> = fc.letrec<{ bool: string }>(tie => ({
  bool: fc.oneof(
    { depthSize: 'small' },
    fc.boolean().map(String),
    fc
      .tuple(intArb, fc.constantFrom('=', '!=', '<', '>', '<=', '>='), intArb)
      .map(([left, operator, right]) => `(${left} ${operator} ${right})`),
    fc
      .tuple(stringArb, fc.constantFrom('=', '!='), stringArb)
      .map(([left, operator, right]) => `(${left} ${operator} ${right})`),
    stringCollectionArb.map(path => `${path}.exists()`),
    stringCollectionArb.map(path => `${path}.empty()`),
    fc
      .tuple(stringArb, fc.constantFrom(...STRING_LITERALS.filter(Boolean)))
      .map(([value, literal]) => `${value}.startsWith('${literal.replace(/'/g, "\\'")}')`),
    fc
      .tuple(tie('bool'), fc.constantFrom('and', 'or', 'xor', 'implies'), tie('bool'))
      .map(([left, operator, right]) => `(${left} ${operator} ${right})`),
    tie('bool').map(value => `${value}.not()`)
  ),
})).bool

const collectionArb: fc.Arbitrary<string> = fc.oneof(
  stringCollectionArb,
  stringCollectionArb.map(path => `${path}.distinct()`),
  stringCollectionArb.map(path => `${path}.tail()`),
  fc.tuple(stringCollectionArb, fc.integer({ min: 0, max: 3 })).map(([path, n]) => `${path}.skip(${n})`),
  fc.tuple(stringCollectionArb, fc.integer({ min: 0, max: 3 })).map(([path, n]) => `${path}.take(${n})`),
  fc.tuple(stringCollectionArb, stringCollectionArb).map(([a, b]) => `(${a} | ${b})`),
  fc.tuple(stringCollectionArb, stringCollectionArb).map(([a, b]) => `${a}.union(${b})`),
  stringCollectionArb.map(path => `${path}.where($this.length() > 2)`),
  stringCollectionArb.map(path => `${path}.select($this.upper())`)
)

const expressionArb = fc.oneof(intArb, stringArb, boolArb, collectionArb)

function ours(expression: string): unknown[] {
  return evaluate(expression, patient, { model: r4Model })
}

function theirs(expression: string): unknown[] {
  // fhirpath.js's own Model type trips over exactOptionalPropertyTypes; the
  // shipped r4 model object is the documented argument.
  return fhirpathjs.evaluate(
    patient,
    expression,
    {},
    fhirpathjsR4Model as Parameters<typeof fhirpathjs.evaluate>[3]
  ) as unknown[]
}

describe('differential fuzz vs fhirpath.js', () => {
  it('generated expressions agree on the patient fixture', () => {
    fc.assert(
      fc.property(expressionArb, expression => {
        expect(JSON.parse(JSON.stringify(ours(expression))), expression).toEqual(
          JSON.parse(JSON.stringify(theirs(expression)))
        )
      }),
      // CI budget: 300 fresh random cases per run (unseeded, so coverage
      // accumulates across runs); a one-off 5k-run sweep passed before merge.
      { numRuns: 300 }
    )
  })
})
