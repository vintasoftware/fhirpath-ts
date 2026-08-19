import {
  type AnalyzerDiagnostic,
  type AnalyzerRoot,
  analyzeRuntimeAstDetailed,
  type RuntimeAnalyzeOptions,
} from '../analyzer/analyze.ts'
import {
  analyzerVariable,
  type AnalyzerVariableState,
  runtimeAnalyzerEnvironmentVariables,
  runtimeAnalyzerVariable,
} from '../analyzer/declarations.ts'
import { normalizeEnvKeys } from '../engine/context.ts'
import { FhirPathTypeError } from '../errors.ts'
import type { ModelProvider } from '../model/provider.ts'
import type { AstNode } from '../parser/ast.ts'
import { parse } from '../parser/parser.ts'
import type { TypedValue } from '../values/typed-value.ts'
import type { AnyExpression, EvaluateOptions } from './compile.ts'

interface StrictFinding {
  diagnostic: AnalyzerDiagnostic
  subject?: string
}

/** Reject every error-severity analyzer finding before strict evaluation begins. */
export function assertStrictExpression(ast: AstNode, root: TypedValue[], options: EvaluateOptions | undefined): void {
  if (options?.strict !== true) {
    return
  }

  const model = options.model
  const analyzerRoot = runtimeRoot(root, model)
  const variables: Record<string, AnalyzerVariableState> = runtimeAnalyzerEnvironmentVariables(
    options.env,
    options.envTypes,
    model
  )
  const declarations = normalizeEnvKeys(options.varTypes)
  const findings: StrictFinding[] = []

  for (const [name, value] of Object.entries(normalizeEnvKeys(options.vars))) {
    const declaration = declarations[name]
    if (isResolvedCollection(value)) {
      variables[name] = runtimeAnalyzerVariable(value, model, declaration)
      continue
    }

    const details = analyzeRuntimeAstDetailed(astOf(value), analyzerOptions(options, variables), analyzerRoot)
    findings.push(
      ...details.diagnostics
        .filter(diagnostic => diagnostic.severity === 'error')
        .map(diagnostic => ({ diagnostic, subject: `vars.${name}` }))
    )
    // A declaration overrides the inferred types and cardinality, but ordering
    // always comes from the analyzed expression — declarations cannot state it.
    variables[name] = {
      ...(declaration === undefined
        ? {
            ...(details.result.types !== undefined && { types: details.result.types }),
            ...(details.result.single !== undefined && { single: details.result.single }),
          }
        : analyzerVariable(declaration)),
      ...(details.result.ordered !== undefined && { ordered: details.result.ordered }),
    }
  }

  for (const [name, declaration] of Object.entries(declarations)) {
    variables[name] ??= analyzerVariable(declaration)
  }

  const details = analyzeRuntimeAstDetailed(ast, analyzerOptions(options, variables), analyzerRoot)
  findings.push(
    ...details.diagnostics.filter(diagnostic => diagnostic.severity === 'error').map(diagnostic => ({ diagnostic }))
  )

  if (findings.length > 0) {
    throw new FhirPathTypeError(formatFindings(findings))
  }
}

function analyzerOptions(
  options: EvaluateOptions,
  variables: Record<string, AnalyzerVariableState>
): RuntimeAnalyzeOptions {
  return {
    ...(options.model !== undefined && { model: options.model }),
    ...(options.functions !== undefined && { functions: options.functions }),
    variables,
  }
}

function runtimeRoot(root: TypedValue[], model: ModelProvider | undefined): AnalyzerRoot {
  const variable = runtimeAnalyzerVariable(root, model)
  return {
    types: variable.types,
    single: variable.single,
    ordered: variable.ordered,
    exactTypes: variable.exactTypes,
  }
}

function isResolvedCollection(value: AnyExpression | readonly TypedValue[]): value is readonly TypedValue[] {
  return Array.isArray(value)
}

function astOf(expression: AnyExpression): AstNode {
  return typeof expression === 'string' ? parse(expression) : expression.ast
}

function formatFindings(findings: StrictFinding[]): string {
  const lines = findings.map(({ diagnostic, subject }) => {
    const prefix = subject === undefined ? '' : `${subject}: `
    return `- [${diagnostic.code}] ${prefix}${diagnostic.message} (line ${diagnostic.span.line}, column ${diagnostic.span.column})`
  })
  return `Strict evaluation failed:\n${lines.join('\n')}`
}
