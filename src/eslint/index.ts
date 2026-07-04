import type { Rule } from 'eslint'
import { analyzeExpression } from '../analyzer/analyze.ts'
import { r4Model } from '../r4/index.ts'

const CALL_NAMES = new Set(['fhirpath', 'compile', 'evaluate', 'analyzeExpression'])

/**
 * ESLint flat-config plugin for consumers whose repos lint with ESLint
 * (this repo itself uses Biome plus the fhirpath-check CLI). Checks every
 * literal FHIRPath expression with the spec §11 analyzer and the R4 model.
 *
 * Usage:
 *   import fhirpathPlugin from '@vinta-bb/fhirpath/eslint'
 *   export default [{ plugins: { fhirpath: fhirpathPlugin }, rules: { 'fhirpath/no-invalid-expressions': 'error' } }]
 */
const noInvalidExpressions: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'check FHIRPath expression literals with the static analyzer',
    },
    schema: [],
  },
  create(context) {
    // Local names bound by imports from other modules: `compile` from handlebars
    // is not a FHIRPath expression. Files without imports are always checked.
    const foreign = new Set<string>()
    const check = (node: Rule.Node, expression: string): void => {
      for (const diagnostic of analyzeExpression(expression, { model: r4Model })) {
        context.report({ node, message: `[${diagnostic.code}] ${diagnostic.message}` })
      }
    }
    return {
      ImportDeclaration(node) {
        if (typeof node.source.value !== 'string' || node.source.value.startsWith('@vinta-bb/fhirpath')) {
          return
        }
        for (const specifier of node.specifiers) {
          foreign.add(specifier.local.name)
        }
      },
      TaggedTemplateExpression(node) {
        const tag = node.tag
        const name = tag.type === 'Identifier' ? tag.name : undefined
        if (name === 'fhirpath' && !foreign.has(name) && node.quasi.expressions.length === 0 && node.quasi.quasis[0]) {
          check(node, node.quasi.quasis[0].value.cooked ?? '')
        }
      },
      CallExpression(node) {
        const callee = node.callee
        const name =
          callee.type === 'Identifier'
            ? callee.name
            : callee.type === 'MemberExpression' && callee.property.type === 'Identifier'
              ? callee.property.name
              : undefined
        const first = node.arguments[0]
        if (
          name !== undefined &&
          CALL_NAMES.has(name) &&
          !(callee.type === 'Identifier' && foreign.has(name)) &&
          first?.type === 'Literal' &&
          typeof first.value === 'string'
        ) {
          check(node, first.value)
        }
      },
    }
  },
}

const plugin = {
  meta: { name: '@vinta-bb/fhirpath', version: '0.1.0' },
  rules: {
    'no-invalid-expressions': noInvalidExpressions,
  },
}

export default plugin
