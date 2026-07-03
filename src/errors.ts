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
  constructor(message: string) {
    super(message)
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
