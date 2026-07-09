import type { EvaluationContext } from '../engine/context.ts'
import { FhirPathTypeError } from '../errors.ts'
import type { AstNode } from '../parser/ast.ts'
import { singleton, wrapBoolean } from '../values/collection.ts'
import { SYSTEM_INTEGER, SYSTEM_STRING, systemTypeOf, type TypedValue } from '../values/typed-value.ts'
import type { NodeEvaluator } from './iteration.ts'
import { argAt, type FhirPathFunction, registerFunction } from './registry.ts'

/** Singleton String input; empty stays empty, anything else is a type error (spec §5.6). */
function stringInput(name: string, input: TypedValue[]): string | undefined {
  const item = singleton(input)
  if (item === undefined) {
    return undefined
  }
  if (systemTypeOf(item) !== SYSTEM_STRING) {
    throw new FhirPathTypeError(`${name}() expects a String input, found ${item.type}`)
  }
  return item.value as string
}

function stringArgument(
  name: string,
  context: EvaluationContext,
  input: TypedValue[],
  node: AstNode,
  evaluateNode: NodeEvaluator
): string | undefined {
  const item = singleton(evaluateNode(node, context, input))
  if (item === undefined) {
    return undefined
  }
  if (systemTypeOf(item) !== SYSTEM_STRING) {
    throw new FhirPathTypeError(`${name}() expects a String argument, found ${item.type}`)
  }
  return item.value as string
}

const str = (value: string): TypedValue[] => [{ type: SYSTEM_STRING, value }]
const int = (value: number): TypedValue[] => [{ type: SYSTEM_INTEGER, value }]

/** Register a function over a singleton String input; empty input propagates. */
function stringFunction(
  name: string,
  arity: { min: number; max: number },
  body: (value: string, args: (string | undefined)[], context: EvaluationContext) => TypedValue[]
): void {
  const fn: FhirPathFunction = {
    minArity: arity.min,
    maxArity: arity.max,
    evaluate: (context, input, args, evaluateNode) => {
      const value = stringInput(name, input)
      if (value === undefined) {
        return []
      }
      const argValues = args.map(arg => stringArgument(name, context, input, arg, evaluateNode))
      return body(value, argValues, context)
    },
  }
  registerFunction(name, fn)
}

stringFunction('indexOf', { min: 1, max: 1 }, (value, [substring]) =>
  substring === undefined ? [] : int(value.indexOf(substring))
)

stringFunction('lastIndexOf', { min: 1, max: 1 }, (value, [substring]) =>
  substring === undefined ? [] : int(value.lastIndexOf(substring))
)

registerFunction('substring', {
  minArity: 1,
  maxArity: 2,
  evaluate: (context, input, args, evaluateNode) => {
    const value = stringInput('substring', input)
    if (value === undefined) {
      return []
    }
    const start = singleton(evaluateNode(argAt(args, 0), context, input), SYSTEM_INTEGER)
    if (start === undefined || typeof start.value !== 'number') {
      return []
    }
    if (start.value < 0 || start.value >= value.length) {
      return []
    }
    if (args.length === 1) {
      return str(value.slice(start.value))
    }
    const lengthCollection = evaluateNode(argAt(args, 1), context, input)
    if (lengthCollection.length === 0) {
      // An empty length means "to the end", like the one-argument form.
      return str(value.slice(start.value))
    }
    const length = singleton(lengthCollection, SYSTEM_INTEGER)
    /* v8 ignore next 3 -- singleton(SYSTEM_INTEGER) only returns integer items */
    if (length === undefined || typeof length.value !== 'number') {
      return []
    }
    return str(value.slice(start.value, start.value + Math.max(0, length.value)))
  },
})

stringFunction('startsWith', { min: 1, max: 1 }, (value, [prefix]) =>
  prefix === undefined ? [] : wrapBoolean(value.startsWith(prefix))
)

stringFunction('endsWith', { min: 1, max: 1 }, (value, [suffix]) =>
  suffix === undefined ? [] : wrapBoolean(value.endsWith(suffix))
)

stringFunction('contains', { min: 1, max: 1 }, (value, [substring]) =>
  substring === undefined ? [] : wrapBoolean(value.includes(substring))
)

stringFunction('upper', { min: 0, max: 0 }, value => str(value.toUpperCase()))

stringFunction('lower', { min: 0, max: 0 }, value => str(value.toLowerCase()))

stringFunction('replace', { min: 2, max: 2 }, (value, [pattern, substitution]) => {
  if (pattern === undefined || substitution === undefined) {
    return []
  }
  if (pattern === '') {
    // Spec: an empty pattern surrounds every character with the substitution.
    return str(substitution + value.split('').join(substitution) + substitution)
  }
  return str(value.split(pattern).join(substitution))
})

function compileRegex(name: string, pattern: string, flags: string): RegExp {
  try {
    // Unicode mode enables \p{...} property escapes and full code-point matching.
    return new RegExp(pattern, `${flags}u`)
  } catch {
    // Patterns with annex-B quirks (e.g. unescaped braces) only compile without it.
  }
  try {
    return new RegExp(pattern, flags)
  } catch {
    throw new FhirPathTypeError(`${name}() received an invalid regular expression`)
  }
}

/**
 * Compile with the host's regex engine (EvaluateOptions.regex) when supplied —
 * the ReDoS protection for untrusted expressions — and the built-in RegExp
 * otherwise. A custom engine's compile errors surface as the same
 * invalid-expression type error the built-in path raises.
 */
function compilePattern(
  name: string,
  context: EvaluationContext,
  pattern: string,
  flags: string
): { test(subject: string): boolean; replace(subject: string, substitution: string): string } {
  if (context.regex !== undefined) {
    try {
      return context.regex.compile(pattern, flags)
    } catch {
      throw new FhirPathTypeError(`${name}() received an invalid regular expression`)
    }
  }
  const compiled = compileRegex(name, pattern, flags)
  return {
    test: subject => compiled.test(subject),
    replace: (subject, substitution) => subject.replace(compiled, substitution),
  }
}

stringFunction('matches', { min: 1, max: 1 }, (value, [pattern], context) =>
  // Single-line mode: `.` matches line terminators (spec §5.6.9).
  pattern === undefined ? [] : wrapBoolean(compilePattern('matches', context, pattern, 's').test(value))
)

stringFunction('matchesFull', { min: 1, max: 1 }, (value, [pattern], context) =>
  pattern === undefined ? [] : wrapBoolean(compilePattern('matchesFull', context, `^(?:${pattern})$`, 's').test(value))
)

stringFunction('replaceMatches', { min: 2, max: 2 }, (value, [pattern, substitution], context) => {
  if (pattern === undefined || substitution === undefined) {
    return []
  }
  // An empty regex matches nothing meaningful; the input passes through unchanged.
  if (pattern === '') {
    return str(value)
  }
  return str(compilePattern('replaceMatches', context, pattern, 'gs').replace(value, substitution))
})

stringFunction('length', { min: 0, max: 0 }, value => int(value.length))

stringFunction('toChars', { min: 0, max: 0 }, value => value.split('').map(ch => ({ type: SYSTEM_STRING, value: ch })))

stringFunction('trim', { min: 0, max: 0 }, value => str(value.trim()))

stringFunction('split', { min: 1, max: 1 }, (value, [separator]) =>
  separator === undefined ? [] : value.split(separator).map(part => ({ type: SYSTEM_STRING, value: part }))
)

// join() works on a collection of strings, not a singleton.
registerFunction('join', {
  minArity: 0,
  maxArity: 1,
  evaluate: (context, input, args, evaluateNode) => {
    const separator = args.length === 1 ? stringArgument('join', context, input, argAt(args, 0), evaluateNode) : ''
    const parts: string[] = []
    for (const item of input) {
      if (systemTypeOf(item) !== SYSTEM_STRING) {
        throw new FhirPathTypeError(`join() expects a collection of strings, found ${item.type}`)
      }
      if (item.value !== undefined) {
        parts.push(item.value as string)
      }
    }
    return str(parts.join(separator ?? ''))
  },
})

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let result = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const chunk = [bytes[i], bytes[i + 1], bytes[i + 2]]
    const combined = ((chunk[0] as number) << 16) | (((chunk[1] ?? 0) as number) << 8) | ((chunk[2] ?? 0) as number)
    result += BASE64_ALPHABET[(combined >> 18) & 63] as string
    result += BASE64_ALPHABET[(combined >> 12) & 63] as string
    result += chunk[1] === undefined ? '=' : (BASE64_ALPHABET[(combined >> 6) & 63] as string)
    result += chunk[2] === undefined ? '=' : (BASE64_ALPHABET[combined & 63] as string)
  }
  return result
}

function decodeBase64(name: string, value: string): string {
  const normalized = value.replace(/=+$/, '')
  const bytes: number[] = []
  let buffer = 0
  let bits = 0
  for (const ch of normalized) {
    const index = BASE64_ALPHABET.indexOf(ch)
    if (index === -1) {
      throw new FhirPathTypeError(`${name}() received invalid base64 input`)
    }
    buffer = (buffer << 6) | index
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

function encodeHex(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let result = ''
  for (const byte of bytes) {
    result += byte.toString(16).padStart(2, '0')
  }
  return result
}

function decodeHex(name: string, value: string): string {
  if (value.length % 2 !== 0 || /[^0-9a-fA-F]/.test(value)) {
    throw new FhirPathTypeError(`${name}() received invalid hex input`)
  }
  const bytes = new Uint8Array(value.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16)
  }
  return new TextDecoder().decode(bytes)
}

stringFunction('encode', { min: 1, max: 1 }, (value, [format]) => {
  switch (format) {
    case undefined:
      return []
    case 'base64':
      return str(encodeBase64(value))
    case 'urlbase64':
      return str(encodeBase64(value).replace(/\+/g, '-').replace(/\//g, '_'))
    case 'hex':
      return str(encodeHex(value))
    default:
      throw new FhirPathTypeError(`encode() does not support the format '${format}'`)
  }
})

stringFunction('decode', { min: 1, max: 1 }, (value, [format]) => {
  switch (format) {
    case undefined:
      return []
    case 'base64':
      return str(decodeBase64('decode', value))
    case 'urlbase64':
      return str(decodeBase64('decode', value.replace(/-/g, '+').replace(/_/g, '/')))
    case 'hex':
      return str(decodeHex('decode', value))
    default:
      throw new FhirPathTypeError(`decode() does not support the format '${format}'`)
  }
})

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

function escapeJson(value: string): string {
  let result = ''
  for (const ch of value) {
    if (ch === '"') {
      result += '\\"'
    } else if (ch === '\\') {
      result += '\\\\'
    } else if (ch === '\n') {
      result += '\\n'
    } else if (ch === '\r') {
      result += '\\r'
    } else if (ch === '\t') {
      result += '\\t'
    } else if (ch < ' ') {
      result += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`
    } else {
      result += ch
    }
  }
  return result
}

/** Backslash sequences decode; everything else (including quote characters) is literal content. */
function unescapeJson(value: string): string {
  let result = ''
  for (let i = 0; i < value.length; i++) {
    const ch = value[i] as string
    if (ch !== '\\') {
      result += ch
      continue
    }
    const next = value[i + 1]
    i += 1
    switch (next) {
      case '"':
      case '\\':
      case '/':
        result += next
        break
      case 'b':
        result += '\b'
        break
      case 'f':
        result += '\f'
        break
      case 'n':
        result += '\n'
        break
      case 'r':
        result += '\r'
        break
      case 't':
        result += '\t'
        break
      case 'u': {
        const hex = value.slice(i + 1, i + 5)
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          throw new FhirPathTypeError('unescape() received invalid JSON string content')
        }
        result += String.fromCharCode(Number.parseInt(hex, 16))
        i += 4
        break
      }
      default:
        throw new FhirPathTypeError('unescape() received invalid JSON string content')
    }
  }
  return result
}

stringFunction('escape', { min: 1, max: 1 }, (value, [target]) => {
  switch (target) {
    case undefined:
      return []
    case 'html':
      return str(value.replace(/[&<>"']/g, ch => HTML_ESCAPES[ch] as string))
    case 'json':
      return str(escapeJson(value))
    default:
      throw new FhirPathTypeError(`escape() does not support the target '${target}'`)
  }
})

stringFunction('unescape', { min: 1, max: 1 }, (value, [target]) => {
  switch (target) {
    case undefined:
      return []
    case 'html':
      return str(
        value
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&amp;/g, '&')
      )
    case 'json':
      return str(unescapeJson(value))
    default:
      throw new FhirPathTypeError(`unescape() does not support the target '${target}'`)
  }
})
