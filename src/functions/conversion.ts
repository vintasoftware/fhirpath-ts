import { FhirPathTypeError } from '../errors'
import { CALENDAR_DURATION_UNITS } from '../lexer/tokens'
import { singleton, wrapBoolean } from '../values/collection'
import { Temporal } from '../values/datetime'
import { Decimal } from '../values/decimal'
import { convertQuantity } from '../values/quantity'
import {
  type QuantityValue,
  SYSTEM_BOOLEAN,
  SYSTEM_DATE,
  SYSTEM_DATETIME,
  SYSTEM_DECIMAL,
  SYSTEM_INTEGER,
  SYSTEM_LONG,
  SYSTEM_QUANTITY,
  SYSTEM_STRING,
  SYSTEM_TIME,
  type TypedValue,
} from '../values/typed-value'
import { registerFunction } from './registry'

type Converter = (item: TypedValue) => TypedValue | undefined

/** Registers `to<Type>()` plus its `convertsTo<Type>()` twin (spec §5.5). */
function conversionPair(typeName: string, convert: Converter): void {
  registerFunction(`to${typeName}`, {
    minArity: 0,
    maxArity: 0,
    evaluate: (_context, input) => {
      const item = singleton(input)
      if (item === undefined) {
        return []
      }
      const converted = convert(item)
      return converted === undefined ? [] : [converted]
    },
  })
  registerFunction(`convertsTo${typeName}`, {
    minArity: 0,
    maxArity: 0,
    evaluate: (_context, input) => {
      const item = singleton(input)
      if (item === undefined) {
        return []
      }
      return wrapBoolean(convert(item) !== undefined)
    },
  })
}

const TRUE_STRINGS = new Set(['true', 't', 'yes', 'y', '1', '1.0'])
const FALSE_STRINGS = new Set(['false', 'f', 'no', 'n', '0', '0.0'])

conversionPair('Boolean', item => {
  switch (item.type) {
    case SYSTEM_BOOLEAN:
      return item
    case SYSTEM_INTEGER: {
      if (item.value === 1) {
        return { type: SYSTEM_BOOLEAN, value: true }
      }
      return item.value === 0 ? { type: SYSTEM_BOOLEAN, value: false } : undefined
    }
    case SYSTEM_DECIMAL: {
      const value = item.value as Decimal
      if (value.equals(new Decimal(1n, 0))) {
        return { type: SYSTEM_BOOLEAN, value: true }
      }
      return value.isZero() ? { type: SYSTEM_BOOLEAN, value: false } : undefined
    }
    case SYSTEM_STRING: {
      const text = (item.value as string).toLowerCase()
      if (TRUE_STRINGS.has(text)) {
        return { type: SYSTEM_BOOLEAN, value: true }
      }
      return FALSE_STRINGS.has(text) ? { type: SYSTEM_BOOLEAN, value: false } : undefined
    }
    default:
      return undefined
  }
})

conversionPair('Integer', item => {
  switch (item.type) {
    case SYSTEM_INTEGER:
      return item
    case SYSTEM_LONG: {
      const value = item.value as bigint
      if (value >= -2147483648n && value <= 2147483647n) {
        return { type: SYSTEM_INTEGER, value: Number(value) }
      }
      return undefined
    }
    case SYSTEM_BOOLEAN:
      return { type: SYSTEM_INTEGER, value: item.value === true ? 1 : 0 }
    case SYSTEM_STRING: {
      if (!/^[+-]?\d+$/.test(item.value as string)) {
        return undefined
      }
      const value = Number.parseInt(item.value as string, 10)
      return Number.isSafeInteger(value) ? { type: SYSTEM_INTEGER, value } : undefined
    }
    default:
      return undefined
  }
})

conversionPair('Long', item => {
  switch (item.type) {
    case SYSTEM_LONG:
      return item
    case SYSTEM_INTEGER:
      return { type: SYSTEM_LONG, value: BigInt(item.value as number) }
    case SYSTEM_BOOLEAN:
      return { type: SYSTEM_LONG, value: item.value === true ? 1n : 0n }
    case SYSTEM_STRING:
      return /^[+-]?\d+$/.test(item.value as string)
        ? { type: SYSTEM_LONG, value: BigInt(item.value as string) }
        : undefined
    default:
      return undefined
  }
})

conversionPair('Decimal', item => {
  switch (item.type) {
    case SYSTEM_DECIMAL:
      return item
    case SYSTEM_INTEGER:
      return { type: SYSTEM_DECIMAL, value: Decimal.fromString(String(item.value as number)) }
    case SYSTEM_LONG:
      return { type: SYSTEM_DECIMAL, value: Decimal.fromString((item.value as bigint).toString()) }
    case SYSTEM_BOOLEAN:
      return { type: SYSTEM_DECIMAL, value: Decimal.fromString(item.value === true ? '1.0' : '0.0') }
    case SYSTEM_STRING: {
      if (!/^[+-]?\d+(\.\d+)?$/.test(item.value as string)) {
        return undefined
      }
      return { type: SYSTEM_DECIMAL, value: Decimal.fromString(item.value as string) }
    }
    default:
      return undefined
  }
})

export function valueToString(item: TypedValue): string | undefined {
  switch (item.type) {
    case SYSTEM_STRING:
      return item.value as string
    case SYSTEM_BOOLEAN:
      return item.value === true ? 'true' : 'false'
    case SYSTEM_INTEGER:
      return String(item.value as number)
    case SYSTEM_LONG:
      return (item.value as bigint).toString()
    case SYSTEM_DECIMAL:
      return (item.value as Decimal).toString()
    case SYSTEM_DATE:
    case SYSTEM_DATETIME:
    case SYSTEM_TIME:
      return (item.value as Temporal).toString()
    case SYSTEM_QUANTITY: {
      const quantity = item.value as QuantityValue
      return quantity.calendar
        ? `${quantity.value.toString()} ${quantity.unit}`
        : `${quantity.value.toString()} '${quantity.unit}'`
    }
    default:
      return undefined
  }
}

conversionPair('String', item => {
  const value = valueToString(item)
  return value === undefined ? undefined : { type: SYSTEM_STRING, value }
})

conversionPair('Date', item => {
  switch (item.type) {
    case SYSTEM_DATE:
      return item
    case SYSTEM_DATETIME: {
      const value = item.value as Temporal
      const truncated = Temporal.fromFields('date', { year: value.year, month: value.month, day: value.day })
      return truncated === undefined ? undefined : { type: SYSTEM_DATE, value: truncated }
    }
    case SYSTEM_STRING: {
      const parsed = Temporal.parseDate(item.value as string)
      return parsed === undefined ? undefined : { type: SYSTEM_DATE, value: parsed }
    }
    default:
      return undefined
  }
})

conversionPair('DateTime', item => {
  switch (item.type) {
    case SYSTEM_DATETIME:
      return item
    case SYSTEM_DATE: {
      const value = item.value as Temporal
      const widened = Temporal.fromFields('dateTime', { year: value.year, month: value.month, day: value.day })
      return widened === undefined ? undefined : { type: SYSTEM_DATETIME, value: widened }
    }
    case SYSTEM_STRING: {
      const parsed = Temporal.parseDateTime(item.value as string)
      return parsed === undefined ? undefined : { type: SYSTEM_DATETIME, value: parsed }
    }
    default:
      return undefined
  }
})

conversionPair('Time', item => {
  switch (item.type) {
    case SYSTEM_TIME:
      return item
    case SYSTEM_STRING: {
      const parsed = Temporal.parseTime(item.value as string)
      return parsed === undefined ? undefined : { type: SYSTEM_TIME, value: parsed }
    }
    default:
      return undefined
  }
})

const QUANTITY_STRING = /^([+-]?\d+(?:\.\d+)?)\s*(?:'([^']+)'|([a-zA-Z]+))?$/

function stringToQuantity(text: string): QuantityValue | undefined {
  const match = QUANTITY_STRING.exec(text.trim())
  if (!match) {
    return undefined
  }
  const [, number, ucumUnit, wordUnit] = match
  const value = Decimal.fromString(number as string)
  /* v8 ignore next 3 -- the regex guarantees a parseable number */
  if (!value) {
    return undefined
  }
  if (ucumUnit !== undefined) {
    return { value, unit: ucumUnit, calendar: false }
  }
  if (wordUnit !== undefined) {
    return CALENDAR_DURATION_UNITS.has(wordUnit) ? { value, unit: wordUnit, calendar: true } : undefined
  }
  return { value, unit: '1', calendar: false }
}

function quantityConverter(item: TypedValue): TypedValue | undefined {
  switch (item.type) {
    case SYSTEM_QUANTITY:
      return item
    case SYSTEM_INTEGER:
    case SYSTEM_DECIMAL:
    case SYSTEM_LONG: {
      const text =
        item.type === SYSTEM_LONG ? (item.value as bigint).toString() : String(item.value as number | Decimal)
      const value = Decimal.fromString(text)
      /* v8 ignore next 3 -- numeric values always render parseable text */
      if (!value) {
        return undefined
      }
      return { type: SYSTEM_QUANTITY, value: { value, unit: '1', calendar: false } }
    }
    case SYSTEM_BOOLEAN:
      return {
        type: SYSTEM_QUANTITY,
        value: {
          value: Decimal.fromString(item.value === true ? '1.0' : '0.0') as Decimal,
          unit: '1',
          calendar: false,
        },
      }
    case SYSTEM_STRING: {
      const parsed = stringToQuantity(item.value as string)
      return parsed === undefined ? undefined : { type: SYSTEM_QUANTITY, value: parsed }
    }
    default:
      return undefined
  }
}

registerFunction('toQuantity', {
  minArity: 0,
  maxArity: 1,
  evaluate: (context, input, args, evaluateNode) => {
    const item = singleton(input)
    if (item === undefined) {
      return []
    }
    const converted = quantityConverter(item)
    if (converted === undefined) {
      return []
    }
    if (args.length === 1) {
      const unitArg = singleton(evaluateNode(args[0] as NonNullable<(typeof args)[0]>, context, input))
      if (unitArg === undefined || unitArg.type !== SYSTEM_STRING) {
        throw new FhirPathTypeError('toQuantity() expects a String unit argument')
      }
      const quantity = converted.value as QuantityValue
      const target = unitArg.value as string
      if (quantity.unit !== target || quantity.calendar) {
        const convertedQuantity = convertQuantity(quantity, target)
        return convertedQuantity === undefined ? [] : [{ type: SYSTEM_QUANTITY, value: convertedQuantity }]
      }
    }
    return [converted]
  },
})

registerFunction('convertsToQuantity', {
  minArity: 0,
  maxArity: 1,
  evaluate: (_context, input) => {
    const item = singleton(input)
    if (item === undefined) {
      return []
    }
    return wrapBoolean(quantityConverter(item) !== undefined)
  },
})
