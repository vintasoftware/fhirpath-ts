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

/** The expression does not match the FHIRPath grammar. Maps to `invalid="syntax"` in the official test suite. */
export class FhirPathSyntaxError extends FhirPathError {
  readonly span: SourceSpan

  constructor(message: string, span: SourceSpan) {
    super(`${message} (line ${span.line}, column ${span.column})`)
    this.span = span
  }
}

/** The expression is grammatical but breaks a typing rule, e.g. a singleton rule or an undefined `%var`. Maps to `invalid="semantic"`. */
export class FhirPathTypeError extends FhirPathError {}

/** Evaluation failed on the given input, e.g. `single()` over many items. Maps to `invalid="execution"`. */
export class FhirPathRuntimeError extends FhirPathError {}

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
