/**
 * Static ReDoS heuristic for literal regex arguments of the matches() family.
 * A synchronous JS engine cannot time out a running RegExp, so catastrophic
 * backtracking is flagged before it runs instead: the classic exponential
 * shape is an unbounded quantifier applied to a group that itself contains an
 * unbounded quantifier — `(a+)+`, `(\d*)*`, `(x|y+)*`. That is what this
 * detects; overlapping-alternation cases like `(a|ab)+` are out of scope.
 */
export function hasNestedUnboundedQuantifier(pattern: string): boolean {
  // Each open group tracks whether an unbounded quantifier appeared inside it.
  const groups: boolean[] = []
  let currentHasUnbounded = false
  let index = 0
  while (index < pattern.length) {
    const char = pattern[index] as string
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === '[') {
      // Character classes repeat single characters; quantifiers inside are literals.
      index += 1
      while (index < pattern.length && pattern[index] !== ']') {
        index += pattern[index] === '\\' ? 2 : 1
      }
      index += 1
      continue
    }
    if (char === '(') {
      groups.push(currentHasUnbounded)
      currentHasUnbounded = false
      index += 1
      continue
    }
    if (char === ')') {
      const groupHadUnbounded = currentHasUnbounded
      currentHasUnbounded = groups.pop() ?? false
      index += 1
      const quantifier = readQuantifier(pattern, index)
      if (quantifier !== undefined) {
        if (groupHadUnbounded && quantifier.unbounded) {
          return true
        }
        currentHasUnbounded ||= quantifier.unbounded
        index = quantifier.end
        continue
      }
      currentHasUnbounded ||= groupHadUnbounded
      continue
    }
    const quantifier = readQuantifier(pattern, index)
    if (quantifier !== undefined && index > 0) {
      currentHasUnbounded ||= quantifier.unbounded
      index = quantifier.end
      continue
    }
    index += 1
  }
  return false
}

/** The quantifier at `index` (`*`, `+`, `{m,}`, `{m,n}`, with lazy `?`), or undefined. */
function readQuantifier(pattern: string, index: number): { unbounded: boolean; end: number } | undefined {
  const char = pattern[index]
  if (char === '*' || char === '+') {
    return { unbounded: true, end: skipLazy(pattern, index + 1) }
  }
  if (char === '?') {
    return { unbounded: false, end: skipLazy(pattern, index + 1) }
  }
  if (char === '{') {
    const match = /^\{(\d+)(,(\d*)?)?\}/.exec(pattern.slice(index))
    if (match === null) {
      return undefined
    }
    // {m} and {m,n} are bounded; {m,} is unbounded.
    const unbounded = match[2] !== undefined && (match[3] === undefined || match[3] === '')
    return { unbounded, end: skipLazy(pattern, index + match[0].length) }
  }
  return undefined
}

function skipLazy(pattern: string, index: number): number {
  return pattern[index] === '?' ? index + 1 : index
}
