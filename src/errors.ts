export interface SourceSpan {
  /** 0-based offset of the first character. */
  start: number
  /** 0-based offset one past the last character. */
  end: number
  /** 1-based line of the first character. */
  line: number
  /** 1-based column of the first character. */
  column: number
}

export class FhirPathError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = new.target.name
  }
}

/** The end of a syntax error's message: where the error is. */
function position(span: SourceSpan): string {
  return ` (line ${span.line}, column ${span.column})`
}

/** The expression does not match the FHIRPath grammar. Maps to `invalid="syntax"` in the official test suite. */
export class FhirPathSyntaxError extends FhirPathError {
  readonly span: SourceSpan

  constructor(message: string, span: SourceSpan, options?: ErrorOptions) {
    super(`${message}${position(span)}`, options)
    this.span = span
  }
}

/**
 * A syntax error of a part of a larger text, such as an embedded expression:
 * `prefix`, then the part's error with its position in the part. The part's
 * error is the `cause`.
 */
export function syntaxErrorOfPart(prefix: string, error: FhirPathSyntaxError): FhirPathSyntaxError {
  const reason = error.message.slice(0, -position(error.span).length)
  return new FhirPathSyntaxError(`${prefix}: ${reason}`, error.span, { cause: error })
}

/** The expression is grammatical but breaks a typing rule, e.g. a singleton rule or an undefined `%var`. Maps to `invalid="semantic"`. */
export class FhirPathTypeError extends FhirPathError {}

/** Evaluation failed on the given input, e.g. `single()` over many items. Maps to `invalid="execution"`. */
export class FhirPathRuntimeError extends FhirPathError {}

/**
 * A synchronous evaluation reached a function that needs a host service only
 * `evaluateAsync()` and `evaluateTypedAsync()` take: a terminology lookup, or
 * `%terminologies`. A host that offers both modes, as fhirpath.js's `async`
 * option does, catches this error and evaluates again asynchronously.
 */
export class FhirPathAsyncRequiredError extends FhirPathRuntimeError {}

/**
 * One row of a `project()` batch failed. `onRowError` receives it; `cause` is
 * the error the row raised. The message names the row and column only, never
 * a value. `subject` is the input resource and may hold PHI, so it is not
 * enumerable: logging or serializing the error leaves it out, and only a
 * caller that reads it explicitly gets it.
 */
export class ProjectionRowError extends FhirPathError {
  /** The row's `%rowIndex`: its position among the projected subjects. */
  readonly index: number
  /** The batch's `%rowTotal`, skipped rows included. */
  readonly total: number
  /** The column being read when the row failed; `undefined` before any column, e.g. a wrong `resourceType` or a `vars` error. */
  readonly column: string | undefined
  /** The input resource (or Bundle entry resource) the row came from. */
  declare readonly subject: unknown

  constructor(cause: unknown, at: { index: number; total: number; column: string | undefined; subject: unknown }) {
    const where = at.column === undefined ? '' : ` in column '${at.column}'`
    super(`project(): row ${at.index} failed${where}`, { cause })
    this.index = at.index
    this.total = at.total
    this.column = at.column
    Object.defineProperty(this, 'subject', { value: at.subject, enumerable: false })
  }
}

/**
 * The message of an error that is safe to log or show: a `FhirPathError`'s
 * own message, which never repeats a value read from the data, or only the
 * error's name for any other error, whose text can carry data. Use it for
 * errors thrown during an evaluation, where host functions, terminology
 * services, and resolvers can also throw.
 */
export function safeErrorMessage(error: unknown): string {
  if (error instanceof FhirPathError) {
    return error.message
  }
  return error instanceof Error ? `Unexpected ${error.name}` : 'Unexpected error'
}
