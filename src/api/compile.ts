import type { CustomFunctionSignature } from '../analyzer/signatures.ts'
import {
  createContext,
  type EvaluationContext,
  forkVariables,
  type HostExpressionFunction,
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
import type { R4TypeOf } from '../r4/generated/type-maps.ts'
import type { FhirpathInput, FhirpathResult, FhirpathResultIn, FhirTypeName } from '../typed/infer.ts'
import { canonicalFocusType } from '../values/type-compat.ts'
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
  | (HostNativeFunction & { signature?: CustomFunctionSignature; expression?: never })
  | {
      expression: AnyExpression
      signature?: CustomFunctionSignature
      fn?: never
      minArity?: never
      maxArity?: never
    }

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
    return evaluateNode(this.ast, contextFactory(options)(root), root)
  }

  /** The canonical form of the expression. */
  toString(): string {
    return printExpression(this.ast)
  }
}

/**
 * Parse an expression once for reuse. Unlike `evaluate()`, does not touch the
 * parse cache. A second argument declares the type the expression runs against,
 * so a relative path infers like a DTO column and the static checkers analyze it
 * against that type — see `fhirpath`, which takes the same declaration.
 */
export function compile<
  const Expr extends string,
  const Root extends FhirTypeName,
  TResult extends unknown[] = FhirpathResultIn<Expr, Root>,
>(expression: Expr, inputType: Root): CompiledExpression<Expr, R4TypeOf[Root], TResult>
export function compile<
  const Expr extends string,
  TInput = FhirpathInput<Expr>,
  TResult extends unknown[] = FhirpathResult<Expr>,
>(expression: Expr): CompiledExpression<Expr, TInput, TResult>
export function compile(expression: string): CompiledExpression {
  // A declared input type is a compile-time and check-time declaration (see
  // `fhirpath`), with nothing for the evaluator to do.
  return new CompiledExpression(expression)
}

/** An expression as text or already compiled, with any literal type. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts any literal-typed CompiledExpression
export type AnyExpression = string | CompiledExpression<any>

/** A pre-resolved `vars` value; Array.isArray alone cannot exclude readonly arrays for the checker. */
function isResolvedCollection<T>(value: T | readonly TypedValue[]): value is readonly TypedValue[] {
  return Array.isArray(value)
}

/** Bind planned vars into a fresh context (see contextFactory for the scoping rules). */
function bindVars(context: EvaluationContext, vars: readonly PlannedVar[]): void {
  for (const [name, value] of vars) {
    if (context.env.has(name)) {
      throw new FhirPathTypeError(`Cannot override the environment variable %${name} with a var`)
    }
    context.variables.set(
      name,
      isResolvedCollection(value) ? [...value] : evaluateNode(value, forkVariables(context), context.root)
    )
  }
}

/** One `vars` entry taken apart at factory time: a parsed body, or a pre-resolved collection. */
type PlannedVar = readonly [name: string, value: AstNode | readonly TypedValue[]]

/** Take a `vars` record apart once — keys normalize, string bodies parse — keeping declaration order. */
function planVars(vars: Record<string, AnyExpression | readonly TypedValue[]>): PlannedVar[] {
  return Object.entries(normalizeEnvKeys(vars)).map(([name, value]) => {
    if (typeof value === 'string') {
      return [name, parse(value)] as const
    }
    return [name, isResolvedCollection(value) ? value : value.ast] as const
  })
}

/**
 * The single mapping from `EvaluateOptions` onto evaluation contexts — every
 * evaluation path builds its context here, so an option added to
 * EvaluateOptions is consumed in one place. Option-wide work happens once per
 * factory (host functions resolve, env keys normalize, var bodies parse); each
 * call then builds one context for its root and binds the vars against it, in
 * declaration order — each body evaluates in the new context (`%context`, env,
 * and every earlier binding in scope, the root as focus), a body's own
 * defineVariable() bindings stay local (forkVariables), a pre-resolved
 * `TypedValue[]` binds without evaluation, and, like defineVariable(), a var
 * may not shadow an environment variable. `extraEnv` carries caller-computed
 * env entries (projectRows' row numbering) that win over same-named option
 * keys.
 */
export function contextFactory(
  options: EvaluateOptions | undefined
): (root: TypedValue[], extraEnv?: Record<string, unknown>) => EvaluationContext {
  const functions = options?.functions === undefined ? undefined : toHostFunctions(options.functions, options.model)
  const env = normalizeEnvKeys(options?.env)
  const vars = options?.vars === undefined ? undefined : planVars(options.vars)
  return (root, extraEnv) => {
    const context = createContext({
      root,
      env: extraEnv === undefined ? env : { ...env, ...extraEnv },
      model: options?.model,
      now: options?.now,
      trace: options?.trace,
      functions,
      regex: options?.regex,
    })
    if (vars !== undefined) {
      bindVars(context, vars)
    }
    return context
  }
}

/**
 * Resolve CustomFunctions to their runtime form: expression bodies parse to
 * ASTs, declared input types resolve against the model, and the rest of the
 * signature stays API-side (the analyzer's half). The model is fixed for a
 * context factory's lifetime, so resolving here is what keeps a per-call
 * question out of every evaluation.
 */
function toHostFunctions(
  functions: Record<string, CustomFunction>,
  model: ModelProvider | undefined
): Record<string, HostFunction> {
  const host: Record<string, HostFunction> = {}
  for (const [name, custom] of Object.entries(functions)) {
    if ('expression' in custom) {
      if ('fn' in custom) {
        throw new FhirPathTypeError(`Custom function '${name}' declares both 'fn' and 'expression'; use one`)
      }
      host[name] = hostExpressionFunction(custom, model)
    } else {
      const inputTypes = hostInputTypes(custom.signature, model)
      // Copied rather than passed through: `custom` is the caller's own object,
      // and the runtime form carries fields the API form does not.
      host[name] = inputTypes === undefined ? custom : { ...custom, inputTypes }
    }
  }
  return host
}

/** The runtime form of an expression-defined CustomFunction: its body, plus what the engine enforces around it. */
function hostExpressionFunction(
  custom: Extract<CustomFunction, { expression: AnyExpression }>,
  model: ModelProvider | undefined
): HostExpressionFunction {
  const { expression } = custom
  const inputTypes = hostInputTypes(custom.signature, model)
  return {
    ast: typeof expression === 'string' ? parse(expression) : expression.ast,
    ...(inputTypes !== undefined && { inputTypes }),
  }
}

/**
 * A signature's declared input types as canonical model names, or undefined when
 * there is nothing the runtime could check: no declaration, no model, or names
 * this model has never heard of (a declaration written against another model is
 * not a reason to fail a call).
 */
function hostInputTypes(
  signature: CustomFunctionSignature | undefined,
  model: ModelProvider | undefined
): readonly string[] | undefined {
  const declared = signature?.input?.types
  if (declared === undefined || model === undefined) {
    return undefined
  }
  const canonical = declared
    .map(type => canonicalFocusType(model, type))
    .filter((type): type is string => type !== undefined)
  return canonical.length === 0 ? undefined : canonical
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
