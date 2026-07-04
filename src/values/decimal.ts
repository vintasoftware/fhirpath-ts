/**
 * Exact decimal arithmetic on a BigInt mantissa with an explicit scale (count of
 * fraction digits). The scale doubles as the value's precision: `1.10` keeps scale 2,
 * which `precision()` and the boundary functions rely on. No floats are involved in
 * `+ - * / div mod`, comparison, or rounding, so `0.1 + 0.2 = 0.3` holds exactly.
 */
export class Decimal {
  /** Scaled integer including the sign: `-1.25` is digits `-125n`, scale 2. */
  readonly digits: bigint
  /** Number of fraction digits; never negative. */
  readonly scale: number

  constructor(digits: bigint, scale: number) {
    this.digits = digits
    this.scale = scale
  }

  /** Parse a decimal string. Accepts exponent notation for values arriving from JSON numbers. */
  static fromString(text: string): Decimal | undefined {
    const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text.trim())
    if (!match) {
      return undefined
    }
    const [, sign, whole, fraction = '', exponentText] = match
    let digits = BigInt(`${whole}${fraction}`)
    if (sign === '-') {
      digits = -digits
    }
    let scale = fraction.length
    const exponent = exponentText === undefined ? 0 : Number.parseInt(exponentText, 10)
    // JS numbers never stringify past e±308; a larger exponent can only come from
    // hostile input and would allocate a giant BigInt.
    if (Math.abs(exponent) > 400) {
      return undefined
    }
    if (exponent > 0) {
      const shift = Math.min(exponent, scale)
      scale -= shift
      digits *= 10n ** BigInt(exponent - shift)
    } else if (exponent < 0) {
      scale -= exponent
    }
    return new Decimal(digits, scale)
  }

  static fromNumber(value: number): Decimal | undefined {
    if (!Number.isFinite(value)) {
      return undefined
    }
    return Decimal.fromString(String(value))
  }

  static zero(): Decimal {
    return new Decimal(0n, 0)
  }

  isZero(): boolean {
    return this.digits === 0n
  }

  isNegative(): boolean {
    return this.digits < 0n
  }

  /** True when the value has no fraction part (trailing fraction zeros count as none). */
  isInteger(): boolean {
    return this.digits % 10n ** BigInt(this.scale) === 0n
  }

  negate(): Decimal {
    return new Decimal(-this.digits, this.scale)
  }

  abs(): Decimal {
    return this.digits < 0n ? this.negate() : this
  }

  add(other: Decimal): Decimal {
    const [a, b, scale] = alignScales(this, other)
    return new Decimal(a + b, scale)
  }

  subtract(other: Decimal): Decimal {
    const [a, b, scale] = alignScales(this, other)
    return new Decimal(a - b, scale)
  }

  multiply(other: Decimal): Decimal {
    return new Decimal(this.digits * other.digits, this.scale + other.scale)
  }

  /** Division; empty (undefined) when dividing by zero. Result is exact up to 24+ fraction digits, then rounded half away from zero and trimmed. */
  divide(other: Decimal): Decimal | undefined {
    if (other.digits === 0n) {
      return undefined
    }
    const targetScale = Math.max(this.scale, other.scale, 8) + 16
    const numerator = this.digits * 10n ** BigInt(targetScale + other.scale - this.scale)
    return new Decimal(divideHalfAwayFromZero(numerator, other.digits), targetScale).trimTrailingZeros()
  }

  /** Truncated integer division (`div`); empty when dividing by zero. */
  integerDivide(other: Decimal): Decimal | undefined {
    if (other.digits === 0n) {
      return undefined
    }
    const [a, b] = alignScales(this, other)
    return new Decimal(a / b, 0)
  }

  /** Remainder (`mod`) with the sign of the dividend; empty when dividing by zero. */
  modulo(other: Decimal): Decimal | undefined {
    if (other.digits === 0n) {
      return undefined
    }
    const [a, b, scale] = alignScales(this, other)
    return new Decimal(a % b, scale)
  }

  compare(other: Decimal): -1 | 0 | 1 {
    const [a, b] = alignScales(this, other)
    if (a < b) {
      return -1
    }
    return a > b ? 1 : 0
  }

  /** Numeric equality; trailing zeros do not matter (`0.5 = 0.50`). */
  equals(other: Decimal): boolean {
    return this.compare(other) === 0
  }

  /** Round half away from zero to `fractionDigits` fraction digits. */
  round(fractionDigits = 0): Decimal {
    if (fractionDigits >= this.scale) {
      return this
    }
    const factor = 10n ** BigInt(this.scale - fractionDigits)
    return new Decimal(divideHalfAwayFromZero(this.digits, factor), fractionDigits)
  }

  /** Drop the fraction part toward zero. */
  truncate(): Decimal {
    return new Decimal(this.digits / 10n ** BigInt(this.scale), 0)
  }

  ceiling(): Decimal {
    const whole = this.truncate()
    if (this.digits > 0n && !this.isInteger()) {
      return new Decimal(whole.digits + 1n, 0)
    }
    return whole
  }

  floor(): Decimal {
    const whole = this.truncate()
    if (this.digits < 0n && !this.isInteger()) {
      return new Decimal(whole.digits - 1n, 0)
    }
    return whole
  }

  /** Reduce the scale by removing trailing fraction zeros, keeping at least `minScale`. */
  trimTrailingZeros(minScale = 0): Decimal {
    let digits = this.digits
    let scale = this.scale
    while (scale > minScale && digits % 10n === 0n) {
      digits /= 10n
      scale -= 1
    }
    return scale === this.scale ? this : new Decimal(digits, scale)
  }

  /** Rescale to exactly `scale` fraction digits (padding with zeros or rounding). */
  withScale(scale: number): Decimal {
    if (scale <= this.scale) {
      return this.round(scale)
    }
    return new Decimal(this.digits * 10n ** BigInt(scale - this.scale), scale)
  }

  toString(): string {
    const negative = this.digits < 0n
    const text = (negative ? -this.digits : this.digits).toString().padStart(this.scale + 1, '0')
    const whole = text.slice(0, text.length - this.scale)
    const fraction = this.scale > 0 ? `.${text.slice(text.length - this.scale)}` : ''
    return `${negative ? '-' : ''}${whole}${fraction}`
  }

  toNumber(): number {
    return Number(this.toString())
  }
}

function alignScales(a: Decimal, b: Decimal): [bigint, bigint, number] {
  const scale = Math.max(a.scale, b.scale)
  return [a.digits * 10n ** BigInt(scale - a.scale), b.digits * 10n ** BigInt(scale - b.scale), scale]
}

function divideHalfAwayFromZero(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator
  const remainder = numerator % denominator
  if (remainder === 0n) {
    return quotient
  }
  const absRemainder = remainder < 0n ? -remainder : remainder
  const absDenominator = denominator < 0n ? -denominator : denominator
  if (absRemainder * 2n >= absDenominator) {
    const negativeResult = numerator < 0n !== denominator < 0n
    return quotient + (negativeResult ? -1n : 1n)
  }
  return quotient
}
