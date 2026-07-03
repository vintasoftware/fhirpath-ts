import type { AstNode } from '../parser/ast'
import { booleanSingleton, wrapBoolean } from '../values/collection'
import { Temporal } from '../values/datetime'
import { SYSTEM_DATE, SYSTEM_DATETIME, SYSTEM_TIME, type TypedValue } from '../values/typed-value'
import { registerFunction } from './registry'

registerFunction('not', {
  minArity: 0,
  maxArity: 0,
  evaluate: (_context, input) => {
    const value = booleanSingleton(input)
    return wrapBoolean(value === undefined ? undefined : !value)
  },
})

registerFunction('trace', {
  minArity: 1,
  maxArity: 2,
  evaluate: (context, input, args, evaluateNode) => {
    const name = evaluateNode(args[0] as AstNode, context, input)
    const label = typeof name[0]?.value === 'string' ? (name[0].value as string) : ''
    const traced = args.length === 2 ? evaluateNode(args[1] as AstNode, context, input) : input
    context.trace(label, traced)
    return input
  },
})

/** The evaluation clock is fixed per evaluation, so these are deterministic within one run. */
function clockParts(now: Date): { date: string; time: string; offset: number } {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const date = `${String(now.getFullYear()).padStart(4, '0')}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  return { date, time, offset: -now.getTimezoneOffset() }
}

registerFunction('now', {
  minArity: 0,
  maxArity: 0,
  evaluate: context => {
    const { date, time, offset } = clockParts(context.now)
    const value = Temporal.parseDateTime(`${date}T${time}`)
    /* v8 ignore next 3 -- the clock always renders a valid dateTime */
    if (!value) {
      return []
    }
    const withOffset = Temporal.fromFields('dateTime', {
      year: value.year,
      month: value.month,
      day: value.day,
      hour: value.hour,
      minute: value.minute,
      second: value.second,
      timezoneOffsetMinutes: offset,
    }) as Temporal
    return [{ type: SYSTEM_DATETIME, value: withOffset }] as TypedValue[]
  },
})

registerFunction('today', {
  minArity: 0,
  maxArity: 0,
  evaluate: context => {
    const { date } = clockParts(context.now)
    const value = Temporal.parseDate(date) as Temporal
    return [{ type: SYSTEM_DATE, value }] as TypedValue[]
  },
})

registerFunction('timeOfDay', {
  minArity: 0,
  maxArity: 0,
  evaluate: context => {
    const { time } = clockParts(context.now)
    const value = Temporal.parseTime(time) as Temporal
    return [{ type: SYSTEM_TIME, value }] as TypedValue[]
  },
})
