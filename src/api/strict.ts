import {
  analyzeAstDetailed,
  type AnalyzeOptions,
  type AnalyzerDiagnostic,
  type AnalyzerRoot,
} from '../analyzer/analyze.ts'
import { analyzerEnvironmentVariables, type AnalyzerVariable, analyzerVariable } from '../analyzer/declarations.ts'
import { normalizeEnvKeys } from '../engine/context.ts'
import { FhirPathTypeError } from '../errors.ts'
import type { ModelProvider } from '../model/provider.ts'
import type { AstNode } from '../parser/ast.ts'
import { parse } from '../parser/parser.ts'
import { type TypedValue, typeLocalName } from '../values/typed-value.ts'
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
  const variables: Record<string, AnalyzerVariable> = analyzerEnvironmentVariables(options.env, options.envTypes, model)
  const declarations = normalizeEnvKeys(options.varTypes)
  const findings: StrictFinding[] = []

  for (const [name, value] of Object.entries(normalizeEnvKeys(options.vars))) {
    const declaration = declarations[name]
    if (isResolvedCollection(value)) {
      variables[name] = declaration === undefined ? variableFromCollection(value, model) : analyzerVariable(declaration)
      continue
    }

    const details = analyzeAstDetailed(astOf(value), analyzerOptions(options, variables), analyzerRoot, true)
    findings.push(
      ...details.diagnostics
        .filter(diagnostic => diagnostic.severity === 'error')
        .map(diagnostic => ({ diagnostic, subject: `vars.${name}` }))
    )
    variables[name] =
      declaration === undefined
        ? {
            ...(details.result.types !== undefined && { types: details.result.types }),
            ...(details.result.single !== undefined && { single: details.result.single }),
          }
        : analyzerVariable(declaration)
  }

  for (const [name, declaration] of Object.entries(declarations)) {
    variables[name] ??= analyzerVariable(declaration)
  }

  const details = analyzeAstDetailed(ast, analyzerOptions(options, variables), analyzerRoot, true)
  findings.push(
    ...details.diagnostics.filter(diagnostic => diagnostic.severity === 'error').map(diagnostic => ({ diagnostic }))
  )

  if (findings.length > 0) {
    throw new FhirPathTypeError(formatFindings(findings))
  }
}

function analyzerOptions(options: EvaluateOptions, variables: Record<string, AnalyzerVariable>): AnalyzeOptions {
  return {
    ...(options.model !== undefined && { model: options.model }),
    ...(options.functions !== undefined && { functions: options.functions }),
    variables,
  }
}

function runtimeRoot(root: TypedValue[], model: ModelProvider | undefined): AnalyzerRoot {
  const inferred = root.map(item => analyzerType(item.type, model))
  const types =
    root.length > 0 && inferred.every((type): type is string => type !== undefined) ? [...new Set(inferred)] : undefined
  return { types, single: root.length <= 1 }
}

function analyzerType(type: string, model: ModelProvider | undefined): string | undefined {
  if (type.startsWith('System.')) {
    return type
  }
  return model?.resolveType(typeLocalName(type))
}

function variableFromCollection(values: readonly TypedValue[], model: ModelProvider | undefined): AnalyzerVariable {
  const inferred = values.map(value => analyzerType(value.type, model))
  const types = inferred.every((type): type is string => type !== undefined) ? [...new Set(inferred)] : undefined
  return { ...(types !== undefined && { types }), single: values.length <= 1 }
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
