import type { R4Resources, R4TypeOf } from '../r4/generated/type-maps.ts'
import type { InferTypeExpression } from './parser.ts'

/** A type name known by the generated R4 model. */
export type FhirTypeName = keyof R4TypeOf & string

/** The inferred result of evaluating a literal FHIRPath expression. */
export type FhirpathResult<Expression extends string> = FhirpathResultIn<Expression, 'opaque'>

/**
 * The inferred result with an explicit FHIR input type. Non-literal,
 * malformed, over-budget, or unsupported expressions safely become
 * `unknown[]`.
 */
export type FhirpathResultIn<Expression extends string, Input extends string> = string extends Expression
  ? unknown[]
  : InferTypeExpression<Expression, Input>

/** The expected input resource for a resource-rooted literal expression. */
export type FhirpathInput<Expression extends string> = string extends Expression
  ? unknown
  : Expression extends `${infer Root}.${string}`
    ? Root extends keyof R4Resources
      ? R4Resources[Root]
      : unknown
    : Expression extends keyof R4Resources
      ? R4Resources[Expression]
      : unknown
