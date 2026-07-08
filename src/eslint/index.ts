import type { Rule } from 'eslint'
import type * as ESTree from 'estree'
import { analyzeExpression } from '../analyzer/analyze.ts'
import {
  CALL_SITES,
  type CallSitePolicy,
  constructsEngine,
  type ExpressionAst,
  expressionEntries,
  isCheckedCall,
  isForeignModule,
  type SourceBindings,
  TAG_NAME,
} from '../analyzer/expression-policy.ts'
import { r4Model } from '../r4/index.ts'

function isStringLiteral(node: ESTree.Node): node is ESTree.SimpleLiteral & { value: string } {
  return node.type === 'Literal' && typeof node.value === 'string'
}

/** Statically-known property key (`path` in `{ path: ... }` or `{ 'path': ... }`), undefined when computed. */
function propertyKeyName(property: ESTree.Property): string | undefined {
  if (property.computed) {
    return undefined
  }
  if (property.key.type === 'Identifier') {
    return property.key.name
  }
  return isStringLiteral(property.key) ? property.key.value : undefined
}

/** How the shared shape extractor reads ESTree nodes. */
const estreeAst: ExpressionAst<ESTree.Node> = {
  string: node => (isStringLiteral(node) ? { node, expression: node.value } : undefined),
  properties: node =>
    node.type === 'ObjectExpression'
      ? node.properties.flatMap(property =>
          property.type === 'Property' ? [{ name: propertyKeyName(property), value: property.value }] : []
        )
      : undefined,
  elements: node => (node.type === 'ArrayExpression' ? node.elements.filter(element => element !== null) : undefined),
}

/** Leftmost identifier of a member-expression callee (`Handlebars` in `Handlebars.compile`). */
function receiverRoot(callee: ESTree.Expression | ESTree.Super): string | undefined {
  if (callee.type !== 'MemberExpression') {
    return undefined
  }
  let current: ESTree.Expression | ESTree.Super = callee.object
  while (current.type === 'MemberExpression') {
    current = current.object
  }
  return current.type === 'Identifier' ? current.name : undefined
}

/**
 * ESLint flat-config plugin for consumers whose repos lint with ESLint (this
 * repo itself uses Biome plus the fhirpath-check CLI). Checks every literal
 * FHIRPath expression with the spec §11 analyzer and the R4 model. Which call
 * sites carry expressions, and which are skipped, is the shared policy's
 * decision — see src/analyzer/expression-policy.ts.
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
    // Candidate sites are collected during ESLint's own traversal and decided in
    // Program:exit, because the bindings that gate them (imports, engine locals)
    // can appear after the calls they gate — a module-scope engine used by an
    // earlier function.
    const foreign = new Set<string>()
    const trusted = new Set<string>()
    const engineLocals: { localName: string; className: string }[] = []
    const tags: { literal: ESTree.TemplateLiteral; expression: string }[] = []
    const calls: {
      policy: CallSitePolicy
      name: string
      receiverRoot: string | undefined
      argument: ESTree.Node
    }[] = []
    const checkAt = (node: ESTree.Node, expression: string): void => {
      for (const diagnostic of analyzeExpression(expression, { model: r4Model })) {
        context.report({ node, message: `[${diagnostic.code}] ${diagnostic.message}` })
      }
    }
    return {
      ImportDeclaration(node) {
        if (typeof node.source.value !== 'string') {
          return
        }
        const names = isForeignModule(node.source.value) ? foreign : trusted
        for (const specifier of node.specifiers) {
          names.add(specifier.local.name)
        }
      },
      VariableDeclarator(node) {
        if (
          node.id.type === 'Identifier' &&
          node.init?.type === 'NewExpression' &&
          node.init.callee.type === 'Identifier'
        ) {
          engineLocals.push({ localName: node.id.name, className: node.init.callee.name })
        }
      },
      TaggedTemplateExpression(node) {
        if (
          node.tag.type === 'Identifier' &&
          node.tag.name === TAG_NAME &&
          node.quasi.expressions.length === 0 &&
          node.quasi.quasis[0]
        ) {
          // Report on the template literal, like the call shapes report on their literals.
          tags.push({ literal: node.quasi, expression: node.quasi.quasis[0].value.cooked ?? '' })
        }
      },
      CallExpression(node) {
        const callee = node.callee
        const name =
          callee.type === 'Identifier'
            ? callee.name
            : callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier'
              ? callee.property.name
              : undefined
        const policy = name === undefined ? undefined : CALL_SITES.get(name)
        const argument = policy && node.arguments[policy.argIndex]
        if (name === undefined || policy === undefined || argument === undefined) {
          return
        }
        calls.push({ policy, name, receiverRoot: receiverRoot(callee), argument })
      },
      'Program:exit'() {
        const bindings: SourceBindings = { foreign, trusted }
        // All imports are known now; resolve engine locals in source order, like the CLI walker.
        for (const { localName, className } of engineLocals) {
          if (constructsEngine(className, bindings)) {
            trusted.add(localName)
          }
        }
        if (!foreign.has(TAG_NAME)) {
          for (const tag of tags) {
            checkAt(tag.literal, tag.expression)
          }
        }
        for (const call of calls) {
          if (!isCheckedCall(call.policy, call.name, call.receiverRoot, bindings)) {
            continue
          }
          for (const entry of expressionEntries(call.argument, call.policy.shape, estreeAst)) {
            checkAt(entry.node, entry.expression)
          }
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
