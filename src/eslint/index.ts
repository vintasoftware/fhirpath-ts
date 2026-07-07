import type { Rule } from 'eslint'
import { analyzeExpression } from '../analyzer/analyze.ts'
import {
  CALL_SITES,
  type CallSiteShape,
  isForeignCall,
  isForeignModule,
  TAG_NAME,
} from '../analyzer/expression-policy.ts'
import { r4Model } from '../r4/index.ts'

// Minimal shape of the ESTree nodes we walk; @types/estree is not a dependency.
interface NodeLike {
  type: string
  object?: NodeLike
  name?: string
  value?: unknown
  key?: NodeLike
  properties?: NodeLike[]
  elements?: (NodeLike | null)[]
  computed?: boolean
}

/** Leftmost identifier of a member-expression callee (`Handlebars` in `Handlebars.compile`). */
function receiverRoot(callee: NodeLike): string | undefined {
  if (callee.type !== 'MemberExpression') {
    return undefined
  }
  let current: NodeLike | undefined = callee.object
  while (current?.type === 'MemberExpression') {
    current = current.object
  }
  return current?.type === 'Identifier' ? current.name : undefined
}

function isStringLiteral(node: NodeLike | null | undefined): node is NodeLike & { value: string } {
  return node?.type === 'Literal' && typeof node.value === 'string'
}

/** Non-computed property name: `path` in `{ path: ... }` or `{ 'path': ... }`. */
function propertyName(property: NodeLike): string | undefined {
  if (property.type !== 'Property' || property.computed) {
    return undefined
  }
  const key = property.key
  return key?.type === 'Identifier' ? key.name : isStringLiteral(key) ? key.value : undefined
}

/** The expression literal(s) an argument holds, per the call site's shape. */
function expressionLiterals(argument: NodeLike, shape: CallSiteShape): (NodeLike & { value: string })[] {
  if (shape === 'expression') {
    return isStringLiteral(argument) ? [argument] : []
  }
  if (shape === 'columns') {
    // project() columns: { name: 'expr' } or { name: { path: 'expr', collection: true } }.
    if (argument.type !== 'ObjectExpression') {
      return []
    }
    return (argument.properties ?? []).flatMap(property => {
      if (propertyName(property) === undefined) {
        return []
      }
      const value = property.value as NodeLike | undefined
      if (isStringLiteral(value)) {
        return [value]
      }
      return value?.type === 'ObjectExpression' ? namedStringProperties(value, 'path') : []
    })
  }
  // checkConstraints() constraints: [{ key, expression: 'expr', ... }].
  if (argument.type !== 'ArrayExpression') {
    return []
  }
  return (argument.elements ?? []).flatMap(element =>
    element?.type === 'ObjectExpression' ? namedStringProperties(element, 'expression') : []
  )
}

/** String-literal values of an object's `name` properties. */
function namedStringProperties(object: NodeLike, name: string): (NodeLike & { value: string })[] {
  return (object.properties ?? []).flatMap(property => {
    const value = property.value as NodeLike | undefined
    return propertyName(property) === name && isStringLiteral(value) ? [value] : []
  })
}

/**
 * ESLint flat-config plugin for consumers whose repos lint with ESLint
 * (this repo itself uses Biome plus the fhirpath-check CLI). Checks every
 * literal FHIRPath expression with the spec §11 analyzer and the R4 model:
 * the fhirpath tag, the expression-first calls (compile, evaluate, ...), and
 * the subject-first FhirPathEngine helpers (test, filter, project,
 * checkConstraints) including expressions inside columns objects and
 * constraint arrays.
 *
 * Usage:
 *   import fhirpathPlugin from 'fhirpath-ts/eslint'
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
        if (typeof node.source.value !== 'string' || !isForeignModule(node.source.value)) {
          return
        }
        for (const specifier of node.specifiers) {
          foreign.add(specifier.local.name)
        }
      },
      TaggedTemplateExpression(node) {
        const tag = node.tag
        const name = tag.type === 'Identifier' ? tag.name : undefined
        if (name === TAG_NAME && !foreign.has(name) && node.quasi.expressions.length === 0 && node.quasi.quasis[0]) {
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
        const policy = name === undefined ? undefined : CALL_SITES.get(name)
        const argument = policy && (node.arguments[policy.argIndex] as NodeLike | undefined)
        if (
          name === undefined ||
          policy === undefined ||
          argument === undefined ||
          isForeignCall(foreign, name, receiverRoot(callee as NodeLike))
        ) {
          return
        }
        for (const literal of expressionLiterals(argument, policy.shape)) {
          check(literal as unknown as Rule.Node, literal.value)
        }
      },
    }
  },
}

const plugin = {
  meta: { name: 'fhirpath-ts', version: '0.1.0' },
  rules: {
    'no-invalid-expressions': noInvalidExpressions,
  },
}

export default plugin
