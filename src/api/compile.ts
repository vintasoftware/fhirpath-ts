import type { CustomFunctionSignature } from '../analyzer/signatures.ts'
import {
  createContext,
  type HostFunction,
  type HostNativeFunction,
  normalizeEnvKeys,
  type RegexEngine,
} from '../engine/context.ts'
import { evaluateNode } from '../engine/evaluator.ts'
import { FhirPathTypeError } from '../errors.ts'
import type { ModelProvider } from '../model/provider.ts'
import type { AstNode } from '../parser/ast.ts'
import { parse } from '../parser/parser.ts'
import { printExpression } from '../parser/printer.ts'
import type { FhirpathInput, FhirpathResult } from '../typed/infer.ts'
import { toCollection, type TypedValue, unwrap } from '../values/typed-value.ts'
import { LruCache } from './cache.ts'

/**
 * A host-supplied FHIRPath function, in one of two forms. Built-in names
 * cannot be overridden by either.
 *
 * Native (HAPI-style triple): `minArity`/`maxArity` resolve it, the optional
 * `signature` lets the static analyzer check it, and `fn` executes it. Plain
 * JS values cross the boundary in both directions; arguments are eager.
 *
 * Expression-defined: `expression` is a FHIRPath body that evaluates as if
 * spliced at the call site — the call's input becomes the focus (and `$this`),
 * while `%context` and the environment stay the caller's. The engine's alias
 * mechanism: name a recurring chain once (`displayText()` for
 * `text | coding.display.first() | …`) instead of splicing strings, and the
 * call keeps values typed end-to-end (no unwrap at the host boundary). Takes
 * zero arguments; a definition that reaches itself, directly or through
 * another definition, fails as recursion. Pass a `CompiledExpression` (or use
 * a `FhirPathEngine`, which pre-compiles through its parse cache) to avoid
 * re-parsing the body on every call.
 *
 * Pass the same record to AnalyzeOptions.functions: without a `signature`,
 * expressions using the function analyze as unknown regions.
 */
export type CustomFunction =
  | (HostNativeFunction & { signature?: CustomFunctionSignature })
  | { expression: AnyExpression; signature?: CustomFunctionSignature }

export interface EvaluateOptions {
  /** Environment variables (`%name`), keyed with or without the leading `%`. */
  env?: Record<string, unknown>
  /**
   * FHIRPath variable bindings (`%name`, keyed with or without the `%`),
   * evaluated against the input before the main expression runs — the option
   * form of `defineVariable()`, and the complement of `env`:
   *
   * - `env` carries host **data** into the evaluation: plain JS values, wrapped
   *   as-is. Use it for lookup tables, system URLs, request parameters.
   * - `vars` carries **derived bindings**: each entry is a FHIRPath expression
   *   the engine evaluates against the same input (so `%context` and `env` are
   *   in scope), bound with full type fidelity — a var holding a dateTime
   *   compares as a dateTime, a Quantity keeps its unit arithmetic. Use it to
   *   name a shared intermediate once instead of splicing it into several
   *   expressions: a joined resource, a chosen element, a decoded row.
   *
   * Entries bind in declaration order, so later vars can reference earlier
   * ones. Like `defineVariable()`, a var may not override an environment
   * variable (including the built-ins) — that throws. In `project()`, vars
   * evaluate once per row, with the row as focus and `%rowIndex`/`%rowTotal`
   * in scope, and every column reads the same bindings.
   *
   * A `readonly TypedValue[]` value (e.g. a previous `evaluateTyped()` result)
   * binds directly without evaluation.
   */
  vars?: Record<string, AnyExpression | readonly TypedValue[]>
  model?: ModelProvider
  /** Evaluation clock for now()/today()/timeOfDay(); defaults to the real time. */
  now?: Date
  /**
   * Sink for trace(name, ...) calls. No default logging: traced values may contain
   * patient data, so sending them anywhere is an explicit choice.
   */
  trace?: (name: string, values: TypedValue[]) => void
  /** Host-supplied functions by name. Declare them to the analyzer too via AnalyzeOptions.functions. */
  functions?: Record<string, CustomFunction>
  /**
   * Regex engine for matches()/matchesFull()/replaceMatches(). The default is
   * the built-in RegExp, which backtracks and cannot be timed out — supply a
   * linear-time engine (e.g. an RE2 binding) when evaluating untrusted
   * expressions (see README, Security).
   */
  regex?: RegexEngine
}

/**
 * A parsed expression, reusable across inputs. Create via `compile()` or the
 * `fhirpath` tag: literal expressions carry inferred result and input types for
 * the supported subset (see src/typed/infer.ts), everything else is unknown[].
 *
 * `TInput`/`TResult` default to the built-in inference but can be overridden,
 * e.g. with `@medplum/fhirtypes` types, for full type-level fidelity with
 * another FHIR type package: `compile<'Patient.name', Patient, HumanName[]>(...)`.
 */
export class CompiledExpression<
  Expr extends string = string,
  TInput = FhirpathInput<Expr>,
  TResult extends unknown[] = FhirpathResult<Expr>,
> {
  readonly source: string
  readonly ast: AstNode

  constructor(source: Expr) {
    this.source = source
    this.ast = parse(source)
  }

  /** Evaluate and unwrap results to plain JS values. */
  evaluate(input?: TInput, options?: EvaluateOptions): TResult {
    return this.evaluateTyped(input, options).map(unwrap) as TResult
  }

  /** Evaluate keeping the internal typed representation (types, Decimal, Temporal). */
  evaluateTyped(input?: unknown, options?: EvaluateOptions): TypedValue[] {
    const root = toCollection(input)
    const context = createContext({
      root,
      env: options?.env,
      vars: options?.vars === undefined ? undefined : resolveVars(options.vars, input, options),
      model: options?.model,
      now: options?.now,
      trace: options?.trace,
      functions: options?.functions === undefined ? undefined : toHostFunctions(options.functions),
      regex: options?.regex,
    })
    return evaluateNode(this.ast, context, root)
  }

  /** The canonical form of the expression. */
  toString(): string {
    return printExpression(this.ast)
  }
}

/** Parse an expression once for reuse. Unlike `evaluate()`, does not touch the parse cache. */
export function compile<
  const Expr extends string,
  TInput = FhirpathInput<Expr>,
  TResult extends unknown[] = FhirpathResult<Expr>,
>(expression: Expr): CompiledExpression<Expr, TInput, TResult> {
  return new CompiledExpression(expression)
}

/** An expression as text or already compiled, with any literal type. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts any literal-typed CompiledExpression
export type AnyExpression = string | CompiledExpression<any>

/**
 * Evaluate `vars` entries into typed collections, in declaration order — each
 * entry evaluates with every earlier one already bound (the recursive
 * `evaluateTyped` call carries them as pre-resolved `TypedValue[]` values, so
 * nothing re-evaluates). Exported for `projectRows`, which resolves once per
 * row and shares the bindings across all columns.
 */
export function resolveVars(
  vars: Record<string, AnyExpression | readonly TypedValue[]>,
  input: unknown,
  options: EvaluateOptions
): Map<string, TypedValue[]> {
  const resolved = new Map<string, TypedValue[]>()
  for (const [name, value] of Object.entries(normalizeEnvKeys(vars))) {
    if (Array.isArray(value)) {
      resolved.set(name, value as TypedValue[])
      continue
    }
    const compiled = typeof value === 'string' ? new CompiledExpression(value) : (value as CompiledExpression)
    resolved.set(name, compiled.evaluateTyped(input, { ...options, vars: Object.fromEntries(resolved) }))
  }
  return resolved
}

/** Resolve CustomFunctions to their runtime form: expression bodies parse to ASTs, signatures stay API-side. */
function toHostFunctions(functions: Record<string, CustomFunction>): Record<string, HostFunction> {
  const host: Record<string, HostFunction> = {}
  for (const [name, custom] of Object.entries(functions)) {
    if ('expression' in custom) {
      if ('fn' in custom) {
        throw new FhirPathTypeError(`Custom function '${name}' declares both 'fn' and 'expression'; use one`)
      }
      const { expression } = custom
      host[name] = { ast: typeof expression === 'string' ? parse(expression) : expression.ast }
    } else {
      host[name] = custom
    }
  }
  return host
}

/** Default for `EngineOptions.cacheSize`, matching Firely's FhirPathCompilerCache default. */
export const DEFAULT_PARSE_CACHE_SIZE = 500

/**
 * Parses an expression, reusing an earlier parse of the same text while it is
 * still cached. An already-compiled expression passes through untouched.
 */
export type Compiler = (expression: AnyExpression) => CompiledExpression<string>

/**
 * A compiler over its own LRU of `capacity` distinct expression texts (`0`
 * caches nothing). Each owner holds one — every `FhirPathEngine`, and the free
 * `evaluate()` — so parses are never reused across them.
 */
export function createCachedCompiler(capacity: number = DEFAULT_PARSE_CACHE_SIZE): Compiler {
  const cache = new LruCache<CompiledExpression>(capacity)
  return expression => {
    if (typeof expression !== 'string') {
      return expression
    }
    let compiled = cache.get(expression)
    if (!compiled) {
      compiled = new CompiledExpression(expression)
      cache.set(expression, compiled)
    }
    return compiled
  }
}
