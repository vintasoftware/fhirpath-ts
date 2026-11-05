import {
  type AnalyzerDiagnostic,
  type AnalyzerRoot,
  analyzeRuntimeAstDetailed,
  type RuntimeAnalyzeOptions,
} from '../analyzer/analyze.ts'
import { type AnalyzerVariableState, evaluationVariables, runtimeAnalyzerVariable } from '../analyzer/declarations.ts'
import { contextResources } from '../engine/context.ts'
import { FhirPathTypeError } from '../errors.ts'
import type { ModelProvider } from '../model/provider.ts'
import type { AstNode } from '../parser/ast.ts'
import { parse } from '../parser/parser.ts'
import type { TypedValue } from '../values/typed-value.ts'
import type { AnyExpression, AsyncEvaluateOptions, EvaluateOptions } from './compile.ts'

interface StrictFinding {
  diagnostic: AnalyzerDiagnostic
  subject?: string
}

/**
 * Reject every error-severity analyzer finding before strict evaluation begins.
 * A declared `inputType` roots the analysis, as it does for the static checkers.
 */
export function assertStrictExpression(
  ast: AstNode,
  root: TypedValue[],
  options: AsyncEvaluateOptions | undefined,
  inputType?: string
): void {
  if (options?.strict !== true) {
    return
  }

  const model = options.model
  const analyzerRoot = runtimeRoot(root, model, inputType)
  const findings: StrictFinding[] = []
  const variables = evaluationVariables(options, model, true, (name, expression, bound) => {
    const details = analyzeRuntimeAstDetailed(astOf(expression), analyzerOptions(options, bound), analyzerRoot)
    findings.push(
      ...details.diagnostics
        .filter(diagnostic => diagnostic.severity === 'error')
        .map(diagnostic => ({ diagnostic, subject: `vars.${name}` }))
    )
    return details.result
  })

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

/**
 * The analyzer root for the data: its types, or the declared input type, which
 * may be a supertype of the data, so it carries no exact types. Cardinality and
 * order always come from the data.
 */
function runtimeRoot(
  root: TypedValue[],
  model: ModelProvider | undefined,
  inputType: string | undefined
): AnalyzerRoot {
  const variable = runtimeAnalyzerVariable(root, model)
  // %resource and %rootResource are the values the evaluation binds, so their types come from the data too.
  const { owner } = contextResources(root)
  const stateOf = (values: TypedValue[]) => {
    const { types, single, ordered } = runtimeAnalyzerVariable(values, model)
    return { types, single, ordered }
  }
  return {
    ...(inputType === undefined
      ? { types: variable.types, single: variable.single, ordered: variable.ordered, exactTypes: variable.exactTypes }
      : { types: [model?.resolveType(inputType) ?? inputType], single: variable.single, ordered: variable.ordered }),
    resources:
      owner === undefined ? {} : { resource: stateOf(owner.resource), rootResource: stateOf(owner.rootResource) },
  }
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
