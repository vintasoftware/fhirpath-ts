/**
 * A `typescript`-free walker for the shared expression-site policy. It finds the
 * FHIRPath expression literals in TypeScript/JavaScript source text by lexing it,
 * so a caller that cannot afford the compiler — a browser playground, a bundler
 * plugin — still applies the same call table, argument positions, receiver rules
 * and expression shapes as the `fhirpath-check` CLI and the ESLint rule. Every
 * *decision* comes from expression-policy.ts; this module supplies only token
 * access, the same division the two AST walkers follow.
 *
 * Where it sees less than the AST walkers it errs toward checking less:
 *
 * - An argument it cannot read as a string, object or array literal is dynamic
 *   and skipped. That includes assertions (`'expr' as const`) and parenthesized
 *   literals, which the AST walkers skip as well.
 * - Only `import` declarations bind names, and only ones written as a statement
 *   with a `from` clause — the same set `collectBindings` reads.
 * - Parameters and declarations go into `rebound` from a token scan, which
 *   over-collects (a `{ evaluate }` object key in a destructuring pattern counts).
 *   Over-collecting only demotes `receiver: 'engine'` trust, so the cost is a
 *   missed check rather than a report on someone else's code.
 *
 * lexical-sites.test.ts holds a parity suite against the TypeScript walker; keep
 * new cases in both or the two will drift.
 */

import {
  CALL_SITES,
  COLUMN_NAME,
  columnFunctionDeclaration,
  constructsEngine,
  type DeclaredColumnFunction,
  DTO_BASE_NAME,
  type ExpressionAst,
  expressionEntries,
  isCheckedCall,
  isForeignModule,
  type LocalModuleOptions,
  type SourceBindings,
  TAG_NAME,
} from './expression-policy.ts'

export interface LexicalExpressionSite {
  expression: string
  /** 0-based offset of the expression's first character in the source text. */
  start: number
  /** The DTO fhirType the expression is analyzed against, when the site fixes one. */
  inputType?: string
  /** A DTO member site: its `%variables` are not the walker's to judge (see `analyzeSite`). */
  dto?: true
  /**
   * The functions the file declares: one per `@column` field, since a registered
   * DTO column is callable from any expression. Shared by every site of the
   * file, and absent when it declares none.
   */
  functions?: Readonly<Record<string, DeclaredColumnFunction>>
}

/**
 * Find the FHIRPath expression literals in `sourceText`: `` fhirpath`...` `` tags
 * plus the literal expression arguments of the calls in `CALL_SITES`, including
 * the ones nested in `project()` columns, `checkConstraints()` constraints, a
 * DTO's `vars`, and its `@column`/`@criteria` fields. `options` widens which
 * import sources count as the real FHIRPath API.
 *
 * A `@column` site is analyzed against its class's fhirType, which the scan
 * takes from the class's `extends defineDto('…')` clause — tracked by token,
 * since there is no tree to climb: a `class` keyword clears the current root and
 * an `extends defineDto('Literal'` sets it, so a class extending a base class or
 * a root-generic factory correctly has none. Each `@column` also declares a
 * function named by the field it decorates — the field name being the next
 * identifier after the decorator — so calls between a file's own columns resolve.
 */
export function findLexicalExpressionSites(
  sourceText: string,
  options: LocalModuleOptions = {}
): LexicalExpressionSite[] {
  const tokens = tokenize(sourceText)
  const bindings = collectBindings(tokens, options)
  const sites: LexicalExpressionSite[] = []
  const functions: Record<string, DeclaredColumnFunction> = {}
  let classRoot: string | undefined
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    if (token.kind !== 'id') {
      continue
    }
    if (token.value === 'class') {
      classRoot = undefined
    } else if (token.value === 'extends') {
      classRoot = extendedDtoRoot(tokens, index)
    }
    const next = tokens[index + 1]
    if (token.value === TAG_NAME && next?.kind === 'tmpl' && next.value !== null) {
      if (!bindings.foreign.has(TAG_NAME)) {
        sites.push({ expression: next.value, start: next.contentStart })
      }
      continue
    }
    const policy = CALL_SITES.get(token.value)
    if (policy === undefined || !isPunct(next, '(')) {
      continue
    }
    if (!isCheckedCall(policy, token.value, receiverRoot(tokens, index), bindings)) {
      continue
    }
    const argument = parseArguments(tokens, index + 1).nodes[policy.argIndex]
    if (argument === undefined) {
      continue
    }
    const inputType =
      policy.rootArg !== undefined
        ? rootArgument(tokens, index, policy.rootArg)
        : policy.rootFromClass === true
          ? classRoot
          : undefined
    if (policy.dto === true && token.value === COLUMN_NAME) {
      const parsed = parseArguments(tokens, index + 1)
      const field = decoratedFieldName(tokens, parsed.end)
      if (field !== undefined) {
        functions[field] = columnFunctionDeclaration(parsed.nodes[1], NODE_AST)
      }
    }
    for (const entry of expressionEntries(argument, policy.shape, NODE_AST)) {
      sites.push({
        expression: entry.expression,
        start: entry.node.start,
        ...(policy.dto === true && { dto: true as const }),
        ...(inputType !== undefined && { inputType }),
      })
    }
  }
  return Object.keys(functions).length === 0 ? sites : sites.map(site => ({ ...site, functions }))
}

/** The name of a `@column`-decorated field: the next identifier, past any further decorators and modifiers. */
function decoratedFieldName(tokens: Token[], from: number): string | undefined {
  for (let index = from; index < tokens.length; index++) {
    const token = tokens[index]!
    if (isPunct(token, '@')) {
      // Another decorator on the same field; skip its name and any arguments.
      const callee = tokens[index + 1]
      index = isPunct(tokens[index + 2], '(') ? parseArguments(tokens, index + 2).end - 1 : index + 1
      if (callee?.kind !== 'id') {
        return undefined
      }
      continue
    }
    if (token.kind !== 'id') {
      return undefined
    }
    if (FIELD_MODIFIERS.has(token.value)) {
      continue
    }
    return token.value
  }
  return undefined
}

/** Modifiers that may sit between a decorator and the field name it belongs to. */
const FIELD_MODIFIERS = new Set([
  'readonly',
  'declare',
  'public',
  'protected',
  'private',
  'static',
  'override',
  'accessor',
  'abstract',
])

/** The fhirType of an `extends defineDto('Condition', …)` clause; undefined for anything else. */
function extendedDtoRoot(tokens: Token[], extendsIndex: number): string | undefined {
  const callee = tokens[extendsIndex + 1]
  const open = tokens[extendsIndex + 2]
  const first = tokens[extendsIndex + 3]
  if (callee?.kind !== 'id' || callee.value !== DTO_BASE_NAME || !isPunct(open, '(') || first?.kind !== 'str') {
    return undefined
  }
  return first.value
}

/** The type name a call declares in `argIndex`, e.g. `fhirpath('status', 'MedicationRequest')`. */
function rootArgument(tokens: Token[], calleeIndex: number, argIndex: number): string | undefined {
  const argument = parseArguments(tokens, calleeIndex + 1).nodes[argIndex]
  return argument?.kind === 'string' ? argument.expression : undefined
}

// --- Tokens -----------------------------------------------------------------

type Token =
  | { kind: 'id' | 'num' | 'punct' | 'regex'; value: string; start: number }
  /** `value` is the decoded text; `contentStart` is the first character inside the quote. */
  | { kind: 'str'; value: string; start: number; contentStart: number }
  /** `value` is null for a template with a `${...}` substitution — those are dynamic. */
  | { kind: 'tmpl'; value: string | null; start: number; contentStart: number }

const isIdentStart = (char: string): boolean => /[A-Za-z_$]/.test(char)
const isIdentPart = (char: string): boolean => /[\w$]/.test(char)
const isDigit = (char: string): boolean => char >= '0' && char <= '9'

/**
 * Keywords after which a `/` opens a regular expression rather than dividing.
 * Everything else that can end an expression — an identifier, a literal, a
 * closing bracket — makes it division.
 */
const REGEX_AFTER_KEYWORD = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'case',
  'do',
  'else',
  'yield',
  'await',
])

/** Whether a `/` following `previous` starts a regular expression literal. */
function startsRegex(previous: Token | undefined): boolean {
  if (previous === undefined) {
    return true
  }
  if (previous.kind === 'id') {
    return REGEX_AFTER_KEYWORD.has(previous.value)
  }
  if (previous.kind === 'punct') {
    return !(previous.value === ')' || previous.value === ']' || previous.value === '}')
  }
  return false
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  while (index < source.length) {
    const char = source[index]!
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      index++
    } else if (char === '/' && source[index + 1] === '/') {
      index = skipTo(source, index + 2, '\n')
    } else if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2)
      index = end === -1 ? source.length : end + 2
    } else if (char === '/' && startsRegex(tokens[tokens.length - 1])) {
      const start = index
      index = skipRegex(source, index)
      tokens.push({ kind: 'regex', value: source.slice(start, index), start })
    } else if (char === "'" || char === '"') {
      const start = index
      const quoted = readQuoted(source, index + 1, char)
      index = quoted.end
      tokens.push({ kind: 'str', value: quoted.value, start, contentStart: start + 1 })
    } else if (char === '`') {
      const start = index
      const template = readTemplate(source, index + 1)
      index = template.end
      tokens.push({ kind: 'tmpl', value: template.value, start, contentStart: start + 1 })
    } else if (isIdentStart(char)) {
      const start = index
      while (index < source.length && isIdentPart(source[index]!)) {
        index++
      }
      tokens.push({ kind: 'id', value: source.slice(start, index), start })
    } else if (isDigit(char)) {
      const start = index
      while (index < source.length && /[\w.]/.test(source[index]!)) {
        index++
      }
      tokens.push({ kind: 'num', value: source.slice(start, index), start })
    } else {
      tokens.push({ kind: 'punct', value: char, start: index })
      index++
    }
  }
  return tokens
}

/** Index just past the next `needle`, or the end of `source`. */
function skipTo(source: string, from: number, needle: string): number {
  const end = source.indexOf(needle, from)
  return end === -1 ? source.length : end + needle.length
}

/** Index just past a regex literal's closing `/` and flags, `/` at `from`. */
function skipRegex(source: string, from: number): number {
  let index = from + 1
  let inClass = false
  while (index < source.length) {
    const char = source[index]!
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === '\n') {
      return index
    }
    if (char === '[') {
      inClass = true
    } else if (char === ']') {
      inClass = false
    } else if (char === '/' && !inClass) {
      index++
      break
    }
    index++
  }
  while (index < source.length && isIdentPart(source[index]!)) {
    index++
  }
  return index
}

/** Read a `'`/`"` string body, `from` being the first character inside the quote. */
function readQuoted(source: string, from: number, quote: string): { value: string; end: number } {
  let value = ''
  let index = from
  while (index < source.length && source[index] !== quote) {
    if (source[index] === '\n') {
      break
    }
    if (source[index] === '\\') {
      const escape = readEscape(source, index + 1)
      value += escape.text
      index = escape.end
    } else {
      value += source[index]
      index++
    }
  }
  return { value, end: index + 1 }
}

/**
 * Read a template body, `from` being the first character inside the backtick.
 * `value` is null once a `${...}` substitution appears — the text is not static.
 */
function readTemplate(source: string, from: number): { value: string | null; end: number } {
  let value = ''
  let dynamic = false
  let index = from
  while (index < source.length && source[index] !== '`') {
    if (source[index] === '\\') {
      const escape = readEscape(source, index + 1)
      value += escape.text
      index = escape.end
    } else if (source[index] === '$' && source[index + 1] === '{') {
      dynamic = true
      index = skipBalanced(source, index + 1, '{', '}')
    } else {
      value += source[index]
      index++
    }
  }
  return { value: dynamic ? null : value, end: index + 1 }
}

const SHORT_ESCAPES: Record<string, string> = {
  n: '\n',
  r: '\r',
  t: '\t',
  b: '\b',
  f: '\f',
  v: '\v',
  '0': '\0',
}

/** Decode one escape sequence, `from` being the character after the backslash. */
function readEscape(source: string, from: number): { text: string; end: number } {
  const char = source[from]
  if (char === undefined) {
    return { text: '', end: from }
  }
  if (char === '\n') {
    // A line continuation contributes nothing to the value.
    return { text: '', end: from + 1 }
  }
  const short = SHORT_ESCAPES[char]
  if (short !== undefined) {
    return { text: short, end: from + 1 }
  }
  // A malformed numeric escape is not an escape at all: the backslash stays in
  // the text, which is what the AST walkers read off the literal's node.
  const raw = { text: `\\${char}`, end: from + 1 }
  if (char === 'x') {
    return readCodePoint(source, from + 1, 2) ?? raw
  }
  if (char === 'u' && source[from + 1] === '{') {
    const close = source.indexOf('}', from + 2)
    const parsed = close === -1 ? undefined : readCodePoint(source, from + 2, close - from - 2)
    return parsed === undefined ? raw : { text: parsed.text, end: close + 1 }
  }
  if (char === 'u') {
    return readCodePoint(source, from + 1, 4) ?? raw
  }
  return { text: char, end: from + 1 }
}

/** Decode `length` hex digits at `from` as a code point, or undefined when malformed. */
function readCodePoint(source: string, from: number, length: number): { text: string; end: number } | undefined {
  const digits = source.slice(from, from + length)
  if (digits.length !== length || !/^[0-9a-fA-F]+$/.test(digits)) {
    return undefined
  }
  const code = Number.parseInt(digits, 16)
  if (code > 0x10ffff) {
    return undefined
  }
  return { text: String.fromCodePoint(code), end: from + length }
}

/** Index just past the `close` matching the `open` at `from`, nesting included. */
function skipBalanced(source: string, from: number, open: string, close: string): number {
  let depth = 0
  let index = from
  while (index < source.length) {
    const char = source[index]!
    if (char === open) {
      depth++
    } else if (char === close) {
      depth--
      if (depth === 0) {
        return index + 1
      }
    } else if (char === "'" || char === '"') {
      index = readQuoted(source, index + 1, char).end
      continue
    } else if (char === '`') {
      index = readTemplate(source, index + 1).end
      continue
    }
    index++
  }
  return index
}

const isPunct = (token: Token | undefined, value: string): boolean => token?.kind === 'punct' && token.value === value

// --- Literal nodes ----------------------------------------------------------

/**
 * The literal shapes `expressionEntries` asks about. `dynamic` covers everything
 * else — a variable, a call, an assertion — which the shared extractor skips.
 */
type Node =
  | { kind: 'string'; start: number; expression: string }
  | { kind: 'object'; start: number; properties: { name: string | undefined; value: Node }[] }
  | { kind: 'array'; start: number; elements: Node[] }
  | { kind: 'dynamic'; start: number }

const NODE_AST: ExpressionAst<Node> = {
  string: node => (node.kind === 'string' ? { node, expression: node.expression } : undefined),
  properties: node => (node.kind === 'object' ? node.properties : undefined),
  elements: node => (node.kind === 'array' ? node.elements : undefined),
}

/** The argument nodes of a call, `open` being the index of its `(`. */
function parseArguments(tokens: Token[], open: number): { nodes: Node[]; end: number } {
  const nodes: Node[] = []
  let index = open + 1
  while (index < tokens.length && !isPunct(tokens[index], ')')) {
    const parsed = parseValue(tokens, index)
    nodes.push(parsed.node)
    index = parsed.end
    if (isPunct(tokens[index], ',')) {
      index++
    } else {
      break
    }
  }
  return { nodes, end: index + 1 }
}

/**
 * Read one value at `index`. A literal the extractor understands becomes its own
 * node kind; anything else becomes `dynamic`, with the token cursor advanced past
 * it so the surrounding list stays in step.
 */
function parseValue(tokens: Token[], index: number): { node: Node; end: number } {
  const token = tokens[index]
  if (token === undefined) {
    return { node: { kind: 'dynamic', start: 0 }, end: index + 1 }
  }
  if (token.kind === 'str') {
    return whole(tokens, { kind: 'string', start: token.contentStart, expression: token.value }, index + 1)
  }
  if (token.kind === 'tmpl' && token.value !== null) {
    return whole(tokens, { kind: 'string', start: token.contentStart, expression: token.value }, index + 1)
  }
  if (isPunct(token, '{')) {
    const parsed = parseObject(tokens, index)
    return whole(tokens, parsed.node, parsed.end)
  }
  if (isPunct(token, '[')) {
    const parsed = parseArray(tokens, index)
    return whole(tokens, parsed.node, parsed.end)
  }
  return { node: { kind: 'dynamic', start: token.start }, end: skipValue(tokens, index) }
}

/**
 * Keep a literal only when it is the entire value. Anything following it — an
 * operator, a `.`, an `as` assertion — means the AST walkers see that outer node
 * instead of a literal and skip it, so the lexical walker has to skip it too.
 */
function whole(tokens: Token[], node: Node, end: number): { node: Node; end: number } {
  const next = tokens[end]
  if (next === undefined || isValueEnd(next)) {
    return { node, end }
  }
  return { node: { kind: 'dynamic', start: node.start }, end: skipValue(tokens, end) }
}

/** Whether a token ends the current value rather than continuing it. */
const isValueEnd = (token: Token): boolean =>
  token.kind === 'punct' &&
  (token.value === ',' || token.value === ')' || token.value === '}' || token.value === ']' || token.value === ';')

function parseObject(tokens: Token[], open: number): { node: Node; end: number } {
  const properties: { name: string | undefined; value: Node }[] = []
  let index = open + 1
  while (index < tokens.length && !isPunct(tokens[index], '}')) {
    const key = tokens[index]!
    let name: string | undefined
    let afterKey = index + 1
    if (key.kind === 'id' || key.kind === 'str' || key.kind === 'num') {
      name = key.kind === 'num' ? undefined : key.value
    } else if (isPunct(key, '[')) {
      // A computed key is not statically known, but its value still counts.
      afterKey = skipBracketed(tokens, index, '[', ']')
    } else {
      // A spread, a method or something else unreadable: skip to the next entry.
      afterKey = index + 1
    }
    if (isPunct(tokens[afterKey], ':')) {
      const parsed = parseValue(tokens, afterKey + 1)
      properties.push({ name, value: parsed.node })
      index = parsed.end
    } else {
      // Shorthand (`{ expression }`) or a method: no literal to read.
      index = skipValue(tokens, index)
    }
    if (isPunct(tokens[index], ',')) {
      index++
    }
  }
  return { node: { kind: 'object', start: tokens[open]!.start, properties }, end: index + 1 }
}

function parseArray(tokens: Token[], open: number): { node: Node; end: number } {
  const elements: Node[] = []
  let index = open + 1
  while (index < tokens.length && !isPunct(tokens[index], ']')) {
    const parsed = parseValue(tokens, index)
    elements.push(parsed.node)
    index = parsed.end
    if (isPunct(tokens[index], ',')) {
      index++
    }
  }
  return { node: { kind: 'array', start: tokens[open]!.start, elements }, end: index + 1 }
}

/** Index just past a value whose shape does not matter, stopping at the enclosing `,` or closer. */
function skipValue(tokens: Token[], from: number): number {
  let index = from
  while (index < tokens.length) {
    const token = tokens[index]!
    if (token.kind === 'punct') {
      if (token.value === ',' || token.value === ')' || token.value === '}' || token.value === ']') {
        return index
      }
      if (token.value === '(' || token.value === '{' || token.value === '[') {
        index = skipBracketed(tokens, index, token.value, CLOSERS[token.value]!)
        continue
      }
    }
    index++
  }
  return index
}

const CLOSERS: Record<string, string> = { '(': ')', '{': '}', '[': ']' }

/** Index just past the `close` matching the bracket at `from`. */
function skipBracketed(tokens: Token[], from: number, open: string, close: string): number {
  let depth = 0
  let index = from
  while (index < tokens.length) {
    const token = tokens[index]!
    if (isPunct(token, open)) {
      depth++
    } else if (isPunct(token, close)) {
      depth--
      if (depth === 0) {
        return index + 1
      }
    }
    index++
  }
  return index
}

// --- Bindings ---------------------------------------------------------------

/** Leftmost identifier of a member-access callee (`Handlebars` in `Handlebars.compile`). */
function receiverRoot(tokens: Token[], callee: number): string | undefined {
  let index = callee - 1
  if (isPunct(tokens[index], '.')) {
    index--
  } else {
    return undefined
  }
  if (isPunct(tokens[index], '?')) {
    index--
  }
  let root: string | undefined
  while (index >= 0) {
    const token = tokens[index]!
    if (isPunct(token, ']')) {
      index = backToOpener(tokens, index, '[', ']') - 1
      continue
    }
    if (token.kind !== 'id') {
      // A call result or `(...)`: no identifier root, same as the AST walkers.
      return undefined
    }
    root = token.value
    index--
    if (isPunct(tokens[index], '.')) {
      index--
      if (isPunct(tokens[index], '?')) {
        index--
      }
      continue
    }
    break
  }
  // `this.engine.evaluate(...)` has no identifier root either.
  return root === 'this' ? undefined : root
}

/** Index of the `open` matching the closer at `from`, scanning left. */
function backToOpener(tokens: Token[], from: number, open: string, close: string): number {
  let depth = 0
  let index = from
  while (index >= 0) {
    if (isPunct(tokens[index], close)) {
      depth++
    } else if (isPunct(tokens[index], open)) {
      depth--
      if (depth === 0) {
        return index
      }
    }
    index--
  }
  return index
}

const DECLARATION_KEYWORDS = new Set(['const', 'let', 'var', 'function', 'class'])

/** `SourceBindings` while it is still being filled in. */
interface CollectedBindings extends SourceBindings {
  foreign: Set<string>
  trusted: Set<string>
  rebound: Set<string>
}

/**
 * Collect the file's name bindings: import names split into foreign and package
 * (trusted), then engine locals (`const engine = new FhirPathEngine(...)`) and
 * every other declared or parameter name as `rebound`. Imports come first so
 * `constructsEngine` can see them, matching the AST walkers' two passes.
 */
function collectBindings(tokens: Token[], options: LocalModuleOptions): SourceBindings {
  const foreign = new Set<string>()
  const trusted = new Set<string>()
  const rebound = new Set<string>()
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    if (token.kind === 'id' && token.value === 'import' && !isPunct(tokens[index - 1], '.')) {
      const clause = readImportClause(tokens, index)
      if (clause !== undefined) {
        const names = isForeignModule(clause.module, options) ? foreign : trusted
        for (const name of clause.names) {
          names.add(name)
        }
        index = clause.end - 1
      }
    }
  }
  const bindings: CollectedBindings = { foreign, trusted, rebound }
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    if (token.kind === 'id' && DECLARATION_KEYWORDS.has(token.value)) {
      collectDeclared(tokens, index + 1, bindings)
    } else if (token.kind === 'id' && token.value === 'catch' && isPunct(tokens[index + 1], '(')) {
      collectPatternNames(tokens, index + 1, skipBracketed(tokens, index + 1, '(', ')'), rebound)
    } else if (isPunct(token, '(')) {
      const end = skipBracketed(tokens, index, '(', ')')
      if (isArrowHead(tokens, end)) {
        collectPatternNames(tokens, index, end, rebound)
      }
    } else if (token.kind === 'id' && isArrowHead(tokens, index + 1)) {
      rebound.add(token.value)
    }
  }
  return bindings
}

const isArrowHead = (tokens: Token[], index: number): boolean =>
  isPunct(tokens[index], '=') && isPunct(tokens[index + 1], '>')

/**
 * Record what a `const`/`let`/`var`/`function`/`class` at `from` declares:
 * a `new`-expression initializer decides between trusted and rebound, everything
 * else — including a function's parameter list — is rebound.
 */
function collectDeclared(tokens: Token[], from: number, bindings: CollectedBindings): void {
  const name = tokens[from]
  if (name?.kind === 'id' && isPunct(tokens[from + 1], '=') && tokens[from + 2]?.kind === 'id') {
    const initializer = tokens[from + 2]!
    const constructed = tokens[from + 3]
    if (initializer.value === 'new' && constructed?.kind === 'id') {
      const set = constructsEngine(constructed.value, bindings) ? bindings.trusted : bindings.rebound
      set.add(name.value)
      return
    }
  }
  if (name?.kind === 'id') {
    bindings.rebound.add(name.value)
    // A function's parameters are declared here too.
    if (isPunct(tokens[from + 1], '(')) {
      collectPatternNames(tokens, from + 1, skipBracketed(tokens, from + 1, '(', ')'), bindings.rebound)
    }
    return
  }
  if (name !== undefined && (isPunct(name, '{') || isPunct(name, '['))) {
    collectPatternNames(tokens, from, skipValue(tokens, from), bindings.rebound)
  }
}

/**
 * Add every identifier between `from` and `end` to `into`. Deliberately broad:
 * over-collecting only demotes `receiver: 'engine'` trust, and a demoted name
 * costs a missed check rather than a report on unrelated code.
 */
function collectPatternNames(tokens: Token[], from: number, end: number, into: Set<string>): void {
  for (let index = from; index < end && index < tokens.length; index++) {
    const token = tokens[index]!
    if (token.kind === 'id' && !isPunct(tokens[index - 1], '.')) {
      into.add(token.value)
    }
  }
}

/**
 * Read the bound names and module of an `import` statement at `from`, or undefined
 * when it is not one (a dynamic `import(...)`, a bare side-effect import). The
 * bound name of each comma-separated group is its last identifier, which lands on
 * the local name for `* as ns`, `a as b` and plain `a` alike.
 */
function readImportClause(tokens: Token[], from: number): { names: string[]; module: string; end: number } | undefined {
  const names: string[] = []
  let group: string | undefined
  let index = from + 1
  while (index < tokens.length) {
    const token = tokens[index]!
    if (token.kind === 'id' && token.value === 'from') {
      const module = tokens[index + 1]
      if (module?.kind !== 'str') {
        return undefined
      }
      if (group !== undefined) {
        names.push(group)
      }
      return { names, module: module.value, end: index + 2 }
    }
    if (token.kind === 'id') {
      group = token.value
    } else if (isPunct(token, ',') || isPunct(token, '{') || isPunct(token, '}')) {
      if (group !== undefined) {
        names.push(group)
        group = undefined
      }
    } else if (!isPunct(token, '*')) {
      // A string (bare import), a `(` (dynamic import), a `;`: not a clause.
      return undefined
    }
    index++
  }
  return undefined
}
