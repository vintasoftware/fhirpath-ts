import { Decimal } from './decimal.ts'

/**
 * Minimal UCUM support: enough units for quantity comparison, conversion, and the
 * official test suites. Factors are exact Decimals, so `1 'm' = 100 'cm'` holds
 * without float drift. Anything outside this table still works as an opaque unit
 * that only compares with itself.
 *
 * UCUM special units are not ratio scales. The offset temperatures (Celsius,
 * Fahrenheit, Réaumur) convert to kelvin; the others, such as the bel, neper,
 * and pH, compare only with the same unit. None takes part in arithmetic
 * (`isSpecialUnit`).
 */

/** Base dimensions; every known unit reduces to a product of these. */
type Dimension = 'g' | 'm' | 's' | 'mol' | 'K' | '1'

interface UnitAtom {
  dimension: Dimension
  /** Factor to the base unit of the dimension, as an exact decimal string. */
  factor: string
  /** Prefixable per UCUM metadata (its metric flag); bracketed and derived units are not. */
  prefixable: boolean
  /**
   * A UCUM special unit. An `offset` unit converts as base = (value + offset) ×
   * factor, standing alone and unprefixed; a `nonratio` unit never converts.
   */
  special?: { kind: 'offset'; offset: string } | { kind: 'nonratio' }
}

const NON_RATIO: UnitAtom = { dimension: '1', factor: '1', prefixable: false, special: { kind: 'nonratio' } }
const NON_RATIO_METRIC: UnitAtom = { ...NON_RATIO, prefixable: true }

const ATOMS: Readonly<Record<string, UnitAtom>> = {
  m: { dimension: 'm', factor: '1', prefixable: true },
  g: { dimension: 'g', factor: '1', prefixable: true },
  s: { dimension: 's', factor: '1', prefixable: true },
  mol: { dimension: 'mol', factor: '1', prefixable: true },
  L: { dimension: 'm', factor: '0.001', prefixable: true }, // handled as m^3 via exponent bump below
  l: { dimension: 'm', factor: '0.001', prefixable: true },
  min: { dimension: 's', factor: '60', prefixable: false },
  h: { dimension: 's', factor: '3600', prefixable: false },
  d: { dimension: 's', factor: '86400', prefixable: false },
  wk: { dimension: 's', factor: '604800', prefixable: false },
  // UCUM's annum is the Julian year; the Julian month is a twelfth of it.
  a: { dimension: 's', factor: '31557600', prefixable: false },
  mo: { dimension: 's', factor: '2629800', prefixable: false },
  '[lb_av]': { dimension: 'g', factor: '453.59237', prefixable: false },
  '[oz_av]': { dimension: 'g', factor: '28.349523125', prefixable: false },
  '[in_i]': { dimension: 'm', factor: '0.0254', prefixable: false },
  '[ft_i]': { dimension: 'm', factor: '0.3048', prefixable: false },
  // Temperature reduces to the Rankine degree, so every factor stays an exact decimal:
  // 1 K = 1.8 °R, and the offset temperatures add their offset first.
  K: { dimension: 'K', factor: '1.8', prefixable: true },
  Cel: { dimension: 'K', factor: '1.8', prefixable: true, special: { kind: 'offset', offset: '273.15' } },
  '[degF]': { dimension: 'K', factor: '1', prefixable: false, special: { kind: 'offset', offset: '459.67' } },
  '[degRe]': { dimension: 'K', factor: '2.25', prefixable: false, special: { kind: 'offset', offset: '218.52' } },
  '1': { dimension: '1', factor: '1', prefixable: false },
  '%': { dimension: '1', factor: '0.01', prefixable: false },
  // The other UCUM special units: logarithmic, trigonometric, and root scales.
  B: NON_RATIO_METRIC,
  'B[SPL]': NON_RATIO_METRIC,
  'B[V]': NON_RATIO_METRIC,
  'B[mV]': NON_RATIO_METRIC,
  'B[uV]': NON_RATIO_METRIC,
  'B[10.nV]': NON_RATIO_METRIC,
  'B[W]': NON_RATIO_METRIC,
  'B[kW]': NON_RATIO_METRIC,
  Np: NON_RATIO_METRIC,
  '[pH]': NON_RATIO,
  "[p'diop]": NON_RATIO,
  '%[slope]': NON_RATIO,
  "[hp'_X]": NON_RATIO,
  "[hp'_C]": NON_RATIO,
  "[hp'_M]": NON_RATIO,
  "[hp'_Q]": NON_RATIO,
  '[m/s2/Hz^(1/2)]': NON_RATIO,
  bit_s: NON_RATIO,
}

/** Units that are volumes even though their atom row reduces through meters. */
const VOLUME_ATOMS = new Set(['L', 'l'])

const PREFIXES: Readonly<Record<string, string>> = {
  T: '1000000000000',
  G: '1000000000',
  M: '1000000',
  k: '1000',
  h: '100',
  da: '10',
  d: '0.1',
  c: '0.01',
  m: '0.001',
  u: '0.000001',
  n: '0.000000001',
  p: '0.000000000001',
}

/** Every spelling of a special unit, prefixed ones included, derived from `ATOMS`. */
const SPECIAL_UNITS: ReadonlySet<string> = new Set(
  Object.entries(ATOMS).flatMap(([key, atom]) =>
    atom.special === undefined ? [] : [key, ...(atom.prefixable ? Object.keys(PREFIXES).map(p => p + key) : [])]
  )
)

export interface CanonicalUnit {
  /** Multiplier to base units, exact. */
  factor: Decimal
  /** Added before the factor, for an offset temperature. */
  offset?: Decimal
  /** Dimension exponents, e.g. `g/m` → { g: 1, m: -1 }. Dimensionless entries are dropped. */
  dimensions: Readonly<Record<string, number>>
}

/**
 * Real UCUM exponents are single-digit (m2, cm3, s2). Larger ones would make
 * powDecimal multiply huge exact BigInts — a tiny expression could hang the
 * process — so anything past this stays an opaque unit.
 */
const MAX_EXPONENT_MAGNITUDE = 9

/** One `atom` optionally followed by an integer exponent, e.g. `m2` or `cm3`. */
function parseComponent(
  text: string
): { factor: Decimal; dimension: Dimension; exponent: number; atom: UnitAtom } | undefined {
  // Whole-text atoms first, so '1' is the unity unit rather than an empty atom with exponent 1.
  const whole = resolveAtom(text)
  if (whole) {
    const volumeBump = VOLUME_ATOMS.has(whole.atomKey) ? 3 : 1
    return { factor: whole.factor, dimension: whole.atom.dimension, exponent: volumeBump, atom: whole.atom }
  }
  const match = /^(.*?)(-?\d+)?$/.exec(text)
  /* v8 ignore next 3 -- the regex cannot fail on any string */
  if (!match) {
    return undefined
  }
  const [, atomText = '', exponentText] = match
  const exponent = exponentText === undefined ? 1 : Number.parseInt(exponentText, 10)
  if (Math.abs(exponent) > MAX_EXPONENT_MAGNITUDE) {
    return undefined
  }
  const resolved = resolveAtom(atomText)
  // A special unit has no powers: 'Cel2' means nothing.
  if (!resolved || resolved.atom.special !== undefined) {
    return undefined
  }
  const volumeBump = VOLUME_ATOMS.has(resolved.atomKey) ? 3 : 1
  const factor = powDecimal(resolved.factor, exponent)
  return { factor, dimension: resolved.atom.dimension, exponent: exponent * volumeBump, atom: resolved.atom }
}

function resolveAtom(text: string): { atom: UnitAtom; atomKey: string; factor: Decimal } | undefined {
  const direct = ATOMS[text]
  if (direct) {
    return { atom: direct, atomKey: text, factor: Decimal.fromString(direct.factor) as Decimal }
  }
  for (const [prefix, prefixFactor] of Object.entries(PREFIXES)) {
    if (text.startsWith(prefix)) {
      const rest = text.slice(prefix.length)
      const atom = ATOMS[rest]
      if (atom?.prefixable) {
        const factor = (Decimal.fromString(atom.factor) as Decimal).multiply(
          Decimal.fromString(prefixFactor) as Decimal
        )
        return { atom, atomKey: rest, factor }
      }
    }
  }
  return undefined
}

function powDecimal(base: Decimal, exponent: number): Decimal {
  if (exponent === 0) {
    return new Decimal(1n, 0)
  }
  let result = new Decimal(1n, 0)
  for (let i = 0; i < Math.abs(exponent); i++) {
    result = result.multiply(base)
  }
  if (exponent < 0) {
    // Factors are exact positive decimals, so the inverse always exists.
    return new Decimal(1n, 0).divide(result) as Decimal
  }
  return result
}

/**
 * Reduce a UCUM expression (`mg`, `m2`, `g/m`, `kg.m/s2`) to base dimensions.
 * Undefined for units outside the table, and for special units other than an
 * offset temperature standing alone and unprefixed — they stay opaque.
 */
export function canonicalizeUnit(unit: string): CanonicalUnit | undefined {
  const [numerator, ...denominators] = unit.split('/')
  let factor = new Decimal(1n, 0)
  let offset: Decimal | undefined
  const dimensions: Record<string, number> = {}
  const apply = (componentText: string, sign: 1 | -1): boolean => {
    const component = parseComponent(componentText)
    const special = component?.atom.special
    if (special !== undefined) {
      // 'Cel' converts; 'mCel', 'Cel/s', and every non-ratio unit do not.
      if (special.kind !== 'offset' || componentText !== unit || !(componentText in ATOMS)) return false
      offset = Decimal.fromString(special.offset) as Decimal
    }
    if (!component) {
      return false
    }
    factor = sign === 1 ? factor.multiply(component.factor) : (factor.divide(component.factor) as Decimal)
    if (component.dimension !== '1') {
      const next = (dimensions[component.dimension] ?? 0) + sign * component.exponent
      if (next === 0) {
        delete dimensions[component.dimension]
      } else {
        dimensions[component.dimension] = next
      }
    }
    return true
  }
  for (const part of (numerator ?? '').split('.')) {
    if (!apply(part, 1)) {
      return undefined
    }
  }
  for (const denominator of denominators) {
    for (const part of denominator.split('.')) {
      if (!apply(part, -1)) {
        return undefined
      }
    }
  }
  return offset === undefined ? { factor, dimensions } : { factor, offset, dimensions }
}

/** A value in base units: (value + offset) × factor. */
export function toBase(value: Decimal, unit: CanonicalUnit): Decimal {
  return (unit.offset === undefined ? value : value.add(unit.offset)).multiply(unit.factor)
}

/** The inverse of `toBase`. Factors are never zero, so the division always succeeds. */
export function fromBase(base: Decimal, unit: CanonicalUnit): Decimal {
  const value = base.divide(unit.factor) as Decimal
  return unit.offset === undefined ? value : value.subtract(unit.offset)
}

/**
 * A UCUM special unit, prefixed or not. Its values are not ratio-scale, so
 * quantity arithmetic and sums give empty.
 */
export function isSpecialUnit(unit: string): boolean {
  return SPECIAL_UNITS.has(unit)
}

export function sameDimensions(a: CanonicalUnit, b: CanonicalUnit): boolean {
  const keysA = Object.keys(a.dimensions)
  const keysB = Object.keys(b.dimensions)
  return keysA.length === keysB.length && keysA.every(key => a.dimensions[key] === b.dimensions[key])
}
