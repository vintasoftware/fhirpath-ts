// Portions of this file are adapted from Medplum (https://github.com/medplum/medplum),
// packages/core/src/types.ts `stringifyTypedValue` and packages/core/src/search/search.ts `parseXFhirQuery`.
// Copyright Orangebot, Inc. and Medplum contributors. Licensed under the Apache License, Version 2.0.
// Changes: rewritten for fhirpath-ts typed values, a collection becomes a comma-separated list as the R5
// x-fhir-query rules say, a Coding without a system is the bare code, each value is percent-encoded, and a value
// whose type has no search form is refused instead of written as JSON.

/**
 * x-fhir-query (https://hl7.org/fhir/R5/fhir-xquery.html): a FHIR search
 * string with FHIRPath expressions in double braces, evaluated and put into
 * the string before the search runs.
 */
import { FhirPathSyntaxError, FhirPathTypeError, syntaxErrorOfPart } from '../errors.ts'
import { Temporal } from '../values/datetime.ts'
import { Decimal } from '../values/decimal.ts'
import { isFhirQuantityType, toFhirQuantity } from '../values/quantity.ts'
import { type QuantityValue, SYSTEM_QUANTITY, type TypedValue, typeLocalName } from '../values/typed-value.ts'
import {
  type AsyncEvaluateOptions,
  compile,
  type CompiledExpression,
  type EvaluateOptions,
  type PromisedAsyncOptions,
} from './compile.ts'

/** One expression per pair of double braces, with no braces inside. */
const EMBEDDED = /{{([^{}]+)}}/g

/** An x-fhir-query parsed once: its embedded expressions, compiled in order. */
export class CompiledXFhirQuery {
  readonly source: string
  /** The embedded expressions, in the order they appear in the query. */
  readonly expressions: readonly CompiledExpression<string>[]

  /**
   * Prefer `compileXFhirQuery(query)`. `compiler` parses each embedded
   * expression; an engine passes its parse cache.
   */
  constructor(query: string, compiler: (expression: string) => CompiledExpression<string> = text => compile(text)) {
    this.source = query
    this.expressions = [...query.matchAll(EMBEDDED)].map((match, index) => {
      try {
        return compiler(match[1] as string)
      } catch (error) {
        if (!(error instanceof FhirPathSyntaxError)) throw error
        throw syntaxErrorOfPart(`Embedded expression ${index + 1} of the x-fhir-query is not valid FHIRPath`, error)
      }
    })
  }

  /**
   * The query with each embedded expression replaced by its results:
   * `results[i]` holds the typed results of `expressions[i]`. Several results
   * become a comma-separated list, and no result an empty value. Throws a
   * FhirPathTypeError that names the type of a result with no search form.
   */
  substitute(results: readonly (readonly TypedValue[])[]): string {
    if (results.length !== this.expressions.length) {
      throw new FhirPathTypeError(
        `The x-fhir-query has ${this.expressions.length} embedded expressions, but substitute() got ${results.length} results`
      )
    }
    let index = 0
    return this.source.replaceAll(EMBEDDED, () =>
      (results[index++] as readonly TypedValue[]).flatMap(searchForms).map(encodeSearchValue).join(',')
    )
  }

  /** Evaluates each embedded expression on `input` with `options`, and gives the substituted query. */
  evaluate(input?: unknown, options?: EvaluateOptions): string {
    return this.substitute(this.expressions.map(expression => expression.evaluateTyped(input, options)))
  }

  /**
   * `evaluate()` with asynchronous services, such as a terminology service.
   * The embedded expressions are evaluated concurrently, and a failure is the
   * first failing expression's error, in query order. With
   * `syncWhenPossible`, a query that needs no service returns its result, or
   * throws, directly.
   */
  evaluateAsync(input?: unknown, options?: PromisedAsyncOptions): Promise<string>
  evaluateAsync(input?: unknown, options?: AsyncEvaluateOptions): string | Promise<string>
  evaluateAsync(input?: unknown, options?: AsyncEvaluateOptions): string | Promise<string> {
    // Each expression runs even when an earlier one fails, so its Promise, if any, is always awaited.
    const outcomes = this.expressions.map((expression): Outcome<TypedValue[] | Promise<TypedValue[]>> => {
      try {
        return { value: expression.evaluateTypedAsync(input, options) }
      } catch (error) {
        return { error }
      }
    })
    if (options?.syncWhenPossible === true && outcomes.every(isSettled)) {
      return this.substitute(outcomes.map(settledValue))
    }
    // allSettled, so the error reported is the first in query order, not the first to settle.
    return Promise.allSettled(
      outcomes.map(async outcome => ('error' in outcome ? Promise.reject(outcome.error) : outcome.value))
    ).then(settled => this.substitute(settled.map(settledValue)))
  }

  toString(): string {
    return this.source
  }
}

/** An evaluation that returned a value or threw. */
type Outcome<T> = { value: T } | { error: unknown }

function isSettled<T>(outcome: Outcome<T | Promise<T>>): outcome is Outcome<T> {
  return !('value' in outcome && outcome.value instanceof Promise)
}

/** The value of a settled evaluation, or its error thrown. */
function settledValue<T>(outcome: Outcome<T> | PromiseSettledResult<T>): T {
  if ('error' in outcome) throw outcome.error
  if ('reason' in outcome) throw outcome.reason
  return outcome.value
}

/**
 * Parse an x-fhir-query once for reuse. Throws a FhirPathSyntaxError that
 * names the embedded expression, counted from 1, that is not valid FHIRPath;
 * its `cause` is the expression's own syntax error.
 */
export function compileXFhirQuery(query: string): CompiledXFhirQuery {
  return new CompiledXFhirQuery(query)
}

/**
 * The search forms of a typed value: one per Coding of a CodeableConcept, and
 * none for a primitive with no value. Throws for a type with no search form.
 */
function searchForms(value: TypedValue): string[] {
  const raw = value.value
  if (raw === undefined) return []
  if (raw instanceof Temporal || raw instanceof Decimal) return [raw.toString()]
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'bigint') return [String(raw)]
  if (typeof raw === 'boolean') return [raw ? 'true' : 'false']
  if (value.type === SYSTEM_QUANTITY) {
    // The UCUM form: a calendar duration such as `3 years` takes its UCUM code `a`.
    const quantity = raw as QuantityValue
    const { system, code } = toFhirQuantity(quantity)
    return [`${quantity.value.toString()}|${system}|${code}`]
  }
  const json = raw as Record<string, unknown>
  const type = value.type.startsWith('FHIR.') ? typeLocalName(value.type) : undefined
  switch (type) {
    case 'Coding':
      return [token(json['system'], json['code'])]
    case 'Identifier':
      return [token(json['system'], json['value'])]
    case 'CodeableConcept':
      return Array.isArray(json['coding'])
        ? json['coding'].map((coding: Record<string, unknown>) => token(coding['system'], coding['code']))
        : []
    case 'Reference':
      return typeof json['reference'] === 'string' ? [json['reference']] : []
  }
  if (type !== undefined && isFhirQuantityType(type)) {
    return [`${text(json['value'])}|${text(json['system'])}|${text(json['code'] ?? json['unit'])}`]
  }
  throw new FhirPathTypeError(`A ${value.type} value cannot be put in an x-fhir-query`)
}

/** A token search value: `system|code`, or the bare code when there is no system. */
function token(system: unknown, code: unknown): string {
  return typeof system === 'string' && system !== '' ? `${system}|${text(code)}` : text(code)
}

function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value)
}

/** Percent-encodes a value for a query string, keeping the characters of a token and of a URL readable. */
function encodeSearchValue(value: string): string {
  return encodeURIComponent(value).replace(/%7C/gi, '|').replace(/%3A/gi, ':').replace(/%2F/gi, '/')
}
