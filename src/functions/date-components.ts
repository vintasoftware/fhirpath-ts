import { singleton } from '../values/collection.ts'
import { Temporal } from '../values/datetime.ts'
import { Decimal } from '../values/decimal.ts'
import { SYSTEM_DATE, SYSTEM_DECIMAL, SYSTEM_INTEGER, SYSTEM_TIME, type TypedValue } from '../values/typed-value.ts'
import { registerFunction } from './registry.ts'

function temporalInput(_name: string, input: TypedValue[]): Temporal | undefined {
  const item = singleton(input)
  if (item === undefined || !(item.value instanceof Temporal)) {
    // Component extraction from a non-temporal value is not applicable → empty.
    return undefined
  }
  return item.value
}

/** Component extractors (ballot §5.8): empty when the value's precision omits the component. */
function componentFunction(name: string, extract: (value: Temporal) => number | undefined): void {
  registerFunction(name, {
    minArity: 0,
    maxArity: 0,
    evaluate: (_context, input) => {
      const temporal = temporalInput(name, input)
      if (temporal === undefined) {
        return []
      }
      const component = extract(temporal)
      return component === undefined ? [] : [{ type: SYSTEM_INTEGER, value: component }]
    },
  })
}

componentFunction('yearOf', value => value.year)
componentFunction('monthOf', value => value.month)
componentFunction('dayOf', value => value.day)
componentFunction('hourOf', value => value.hour)
componentFunction('minuteOf', value => value.minute)
componentFunction('secondOf', value => value.second)
componentFunction('millisecondOf', value =>
  value.fraction === undefined ? undefined : Number.parseInt(value.fraction.padEnd(3, '0').slice(0, 3), 10)
)

registerFunction('timezoneOffsetOf', {
  minArity: 0,
  maxArity: 0,
  evaluate: (_context, input) => {
    const temporal = temporalInput('timezoneOffsetOf', input)
    if (temporal === undefined || temporal.timezoneOffsetMinutes === undefined) {
      return []
    }
    // Offset in hours as a Decimal: +05:30 is 5.5.
    const hours = Decimal.fromString(String(temporal.timezoneOffsetMinutes / 60))
    /* v8 ignore next -- minutes divided by 60 always renders a parseable number */
    return hours === undefined ? [] : [{ type: SYSTEM_DECIMAL, value: hours }]
  },
})

registerFunction('dateOf', {
  minArity: 0,
  maxArity: 0,
  evaluate: (_context, input) => {
    const temporal = temporalInput('dateOf', input)
    if (temporal === undefined || temporal.kind === 'time') {
      return []
    }
    const date = Temporal.fromFields('date', { year: temporal.year, month: temporal.month, day: temporal.day })
    /* v8 ignore next -- components come from an already-valid Temporal */
    return date === undefined ? [] : [{ type: SYSTEM_DATE, value: date }]
  },
})

registerFunction('timeOf', {
  minArity: 0,
  maxArity: 0,
  evaluate: (_context, input) => {
    const temporal = temporalInput('timeOf', input)
    if (temporal === undefined || temporal.kind !== 'dateTime' || temporal.hour === undefined) {
      return []
    }
    const time = Temporal.fromFields('time', {
      hour: temporal.hour,
      minute: temporal.minute,
      second: temporal.second,
      fraction: temporal.fraction,
    })
    /* v8 ignore next -- components come from an already-valid Temporal */
    return time === undefined ? [] : [{ type: SYSTEM_TIME, value: time }]
  },
})
