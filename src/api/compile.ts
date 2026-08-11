import type { CustomFunctionSignature } from '../analyzer/signatures.ts'
import {
  createContext,
  envCollections,
  type EvaluationContext,
  forkVariables,
  type HostExpressionFunction,
  type HostFunction,
  type HostNativeFunction,
  type HostSingleFunction,
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
import type {
  CheckedFhirpathOptionValues,
  EmptyFhirpathTypeContext,
  FhirpathInput,
  FhirpathResultForContext,
  FhirpathTypeContextOf,
  FhirpathTypeDeclarations,
  FhirTypeName,
} from '../typed/infer.ts'
import { toCollection, type TypedValue, unwrap } from '../values/typed-value.ts'
import { LruCache } from './cache.ts'

/**
 * A native or expression-defined FHIRPath function. Native functions receive
 * evaluated JavaScript values. Expression functions take no arguments, keep
 * FHIRPath types, and use the call focus with the caller's `%context` and
 * environment. A signature lets the analyzer check either form. Built-in names
 * cannot be replaced.
 */
export type SingleCustomFunction =
  | (HostNativeFunction & {
      signature?: CustomFunctionSignature
      expression?: never
      criteria?: never
      /** Only an expression body reads `%name`; a native `fn` gets plain values. */
      env?: never
      envTypes?: never
    })
  | {
      expression: AnyExpression
      signature?: CustomFunctionSignature
      /** Environment values available only while this expression body runs. */
      env?: Record<string, unknown>
      /** Static declarations for values in this function-local environment. */
      envTypes?: FhirpathTypeDeclarations
      /** Return one criteria Boolean. An empty body result becomes `false`. */
      criteria?: boolean
      fn?: never
      minArity?: never
      maxArity?: never
    }

/** Same-name functions selected in order by `signature.input.types`. */
export interface OverloadedCustomFunction {
  overloads: readonly SingleCustomFunction[]
  fn?: never
  expression?: never
  signature?: never
  criteria?: never
  env?: never
  envTypes?: never
  minArity?: never
  maxArity?: never
}

export type CustomFunction = SingleCustomFunction | OverloadedCustomFunction

export interface EvaluateOptions {
  /** Environment variables (`%name`), keyed with or without the leading `%`. */
  env?: Record<string, unknown>
  /** Static types for environment variables; declarations never create runtime values. */
  envTypes?: FhirpathTypeDeclarations
  /**
   * FHIRPath bindings evaluated against the input in declaration order. They
   * keep FHIRPath types and may use `%context`, `env`, and earlier variables.
   * During projection they run once per row. A `TypedValue[]` binds directly.
   */
  vars?: Record<string, AnyExpression | readonly TypedValue[]>
  /** Static types for pre-resolved vars, or explicit overrides for expression vars. */
  varTypes?: FhirpathTypeDeclarations
  model?: ModelProvider
  /** Clock for `now()`, `today()`, and `timeOfDay()`. Defaults to the current time. */
  now?: Date
  /**
   * Sink for trace(name, ...) calls. No default logging: traced values may contain
   * patient data, so sending them anywhere is an explicit choice.
   */
  trace?: (name: string, values: TypedValue[]) => void
  /** Host functions by name. Pass the same declarations to `AnalyzeOptions.functions`. */
  functions?: Record<string, CustomFunction>
  /**
   * Regex engine for matches()/matchesFull()/replaceMatches(). The default is
   * the built-in RegExp, which backtracks and cannot be timed out — supply a
   * linear-time engine (e.g. an RE2 binding) when evaluating untrusted
   * expressions (see README, Security).
   */
  regex?: RegexEngine
}

type CheckedOptionKeys<Options, Accepted> = string extends keyof Options
  ? unknown
  : keyof EvaluateOptions extends keyof Options
    ? unknown
    : Record<Exclude<keyof Options, keyof Accepted>, never>

/**
 * Keeps literal option declarations for inference and rejects unknown literal
 * keys. Named extensions of the accepted options and index-signature records
 * remain assignable.
 */
export type Declaring<Options extends object, Accepted extends EvaluateOptions = EvaluateOptions> = Accepted &
  Options &
  CheckedFhirpathOptionValues<Options> &
  CheckedOptionKeys<Options, Accepted>

/** Sentinel selecting built-in result inference instead of an explicit TResult. */
export interface InferredExpressionResult {
  readonly __inferredExpressionResult: unique symbol
}

/** The result of a compiled expression after applying its per-call static declarations. */
export type CompiledExpressionResult<
  Expr extends string,
  TResult extends unknown[] | InferredExpressionResult,
  Root extends string,
  Options,
> = TResult extends InferredExpressionResult
  ? FhirpathResultForContext<Expr, Root, FhirpathTypeContextOf<Options>>
  : Extract<TResult, unknown[]>

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
  TResult extends unknown[] | InferredExpressionResult = InferredExpressionResult,
  Root extends string = 'opaque',
> {
  readonly source: Expr
  readonly ast: AstNode

  constructor(source: Expr) {
    this.source = source
    this.ast = parse(source)
  }

  /** Evaluate and unwrap results to plain JS values. */
  evaluate<const Options extends object = EmptyFhirpathTypeContext>(
    input?: TInput,
    options?: Declaring<Options>
  ): CompiledExpressionResult<Expr, TResult, Root, Options> {
    return this.evaluateTyped(input, options).map(unwrap) as CompiledExpressionResult<Expr, TResult, Root, Options>
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
  TResult extends unknown[] | InferredExpressionResult = InferredExpressionResult,
>(expression: Expr, inputType: Root): CompiledExpression<Expr, R4TypeOf[Root], TResult, Root>
export function compile<
  const Expr extends string,
  TInput = FhirpathInput<Expr>,
  TResult extends unknown[] | InferredExpressionResult = InferredExpressionResult,
>(expression: Expr): CompiledExpression<Expr, TInput, TResult>
export function compile(expression: string): CompiledExpression {
  // A declared input type is a compile-time and check-time declaration (see
  // `fhirpath`), with nothing for the evaluator to do.
  return new CompiledExpression(expression)
}

/** An expression as text or already compiled, with any literal, input, result, and root types. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts every CompiledExpression specialization
export type AnyExpression = string | CompiledExpression<any, any, any, any>

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
 * Prepares options once, then creates an evaluation context for each root.
 * Variables bind in order. `extraEnv` contains call-specific values, such as
 * projection row numbers, and replaces matching option values.
 */
export function contextFactory(
  options: EvaluateOptions | undefined
): (root: TypedValue[], extraEnv?: Record<string, unknown>) => EvaluationContext {
  const functions = options?.functions === undefined ? undefined : toHostFunctions(options.functions)
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
 * Converts CustomFunctions to their runtime form. Expression bodies parse to
 * ASTs, and the declared input types come across for the engine to check. The
 * rest of the signature stays in the API layer, which is the analyzer's half.
 */
function toHostFunctions(functions: Record<string, CustomFunction>): Record<string, HostFunction> {
  const host: Record<string, HostFunction> = {}
  for (const [name, custom] of Object.entries(functions)) {
    host[name] =
      'overloads' in custom
        ? { overloads: custom.overloads.map(overload => toHostFunction(name, overload)) }
        : toHostFunction(name, custom)
  }
  return host
}

function toHostFunction(name: string, custom: SingleCustomFunction): HostSingleFunction {
  if ('expression' in custom) {
    if ('fn' in custom) {
      throw new FhirPathTypeError(`Custom function '${name}' declares both 'fn' and 'expression'; use one`)
    }
    return hostExpressionFunction(custom)
  }
  const inputTypes = custom.signature?.input?.types
  // Copy rather than pass through. `custom` is the caller's own object, and the
  // runtime form carries fields the API form does not.
  return inputTypes === undefined ? custom : { ...custom, inputTypes }
}

/** The runtime form of an expression-defined CustomFunction: its body, plus what the engine checks around it. */
function hostExpressionFunction(
  custom: Extract<SingleCustomFunction, { expression: AnyExpression }>
): HostExpressionFunction {
  const { expression, signature } = custom
  const inputTypes = signature?.input?.types
  return {
    ast: typeof expression === 'string' ? parse(expression) : expression.ast,
    ...(inputTypes !== undefined && { inputTypes }),
    ...(custom.env !== undefined && { env: envOverlay(custom.env) }),
    ...(custom.criteria === true && { criteria: true }),
  }
}

/**
 * Overlays already built, by the env record they were built from. A context
 * factory is made per evaluation and resolves every host function, so without
 * this a DTO's tables would be re-wrapped on every `evaluate()` — including
 * evaluations that never call one of its columns. The record is the DTO's
 * cached definition, one object shared by all of its columns, so the entry is
 * reached again on the next evaluation and released with the class.
 */
const overlays = new WeakMap<object, ReadonlyMap<string, TypedValue[]>>()

/** A definition's own env as the collections the context binds, wrapped once per record. */
function envOverlay(env: Record<string, unknown>): ReadonlyMap<string, TypedValue[]> {
  let overlay = overlays.get(env)
  if (overlay === undefined) {
    overlay = envCollections(env)
    overlays.set(env, overlay)
  }
  return overlay
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
