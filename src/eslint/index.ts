import type { Rule } from 'eslint'
import { analyzeExpression } from '../analyzer/analyze.ts'
import {
  CALL_SITES,
  constructsEngine,
  type ExpressionAst,
  expressionEntries,
  isCheckedCall,
  isForeignModule,
  type SourceBindings,
  TAG_NAME,
} from '../analyzer/expression-policy.ts'
import { r4Model } from '../r4/index.ts'

// Minimal shape of the ESTree nodes we walk; @types/estree is not a dependency.
interface NodeLike {
  type: string
  loc?: { start: { line: number; column: number }; end: { line: number; column: number } } | null
  // Identifiers and literals.
  name?: string
  value?: unknown
  // Member expressions.
  object?: NodeLike
  computed?: boolean
  // Object/array literals and their properties.
  key?: NodeLike
  properties?: NodeLike[]
  elements?: (NodeLike | null)[]
  // Imports and variable declarations, for binding collection.
  body?: NodeLike[]
  source?: NodeLike
  specifiers?: NodeLike[]
  local?: NodeLike
  id?: NodeLike
  init?: NodeLike
  callee?: NodeLike
}

function isNodeLike(value: unknown): value is NodeLike {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string'
}

function isStringLiteral(node: NodeLike | null | undefined): node is NodeLike & { value: string } {
  return node?.type === 'Literal' && typeof node.value === 'string'
}

/** Statically-known property key (`path` in `{ path: ... }` or `{ 'path': ... }`), undefined when computed. */
function propertyKeyName(property: NodeLike): string | undefined {
  if (property.computed) {
    return undefined
  }
  if (property.key?.type === 'Identifier') {
    return property.key.name
  }
  return isStringLiteral(property.key) ? property.key.value : undefined
}

/** How the shared shape extractor reads ESTree nodes. */
const estreeAst: ExpressionAst<NodeLike> = {
  string: node => (isStringLiteral(node) ? { node, expression: node.value } : undefined),
  properties: node =>
    node.type === 'ObjectExpression'
      ? (node.properties ?? []).flatMap(property =>
          property.type === 'Property' && isNodeLike(property.value)
            ? [{ name: propertyKeyName(property), value: property.value }]
            : []
        )
      : undefined,
  elements: node =>
    node.type === 'ArrayExpression'
      ? (node.elements ?? []).filter((element): element is NodeLike => element !== null)
      : undefined,
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

/** Depth-first walk over an ESTree subtree, skipping parent back-references and token lists. */
function walkTree(node: NodeLike, visit: (node: NodeLike) => void): void {
  visit(node)
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent' || key === 'tokens' || key === 'comments') {
      continue
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isNodeLike(item)) {
          walkTree(item, visit)
        }
      }
    } else if (isNodeLike(value)) {
      walkTree(value, visit)
    }
  }
}

/**
 * Collect the file's name bindings before any call is checked: foreign-import
 * and package-import names from the top-level import statements, then engine
 * locals (`const engine = new FhirPathEngine(...)`) from the whole tree — a
 * separate pass so use-before-declaration (a module-scope engine used by an
 * earlier function) still counts, matching the CLI walker.
 */
function collectBindings(program: NodeLike): SourceBindings {
  const foreign = new Set<string>()
  const engines = new Set<string>()
  const bindings = { foreign, engines }
  for (const statement of program.body ?? []) {
    if (statement.type !== 'ImportDeclaration' || typeof statement.source?.value !== 'string') {
      continue
    }
    const names = isForeignModule(statement.source.value) ? foreign : engines
    for (const specifier of statement.specifiers ?? []) {
      if (specifier.local?.name !== undefined) {
        names.add(specifier.local.name)
      }
    }
  }
  walkTree(program, node => {
    if (
      node.type === 'VariableDeclarator' &&
      node.id?.type === 'Identifier' &&
      node.id.name !== undefined &&
      node.init?.type === 'NewExpression' &&
      node.init.callee?.type === 'Identifier' &&
      node.init.callee.name !== undefined &&
      constructsEngine(node.init.callee.name, bindings)
    ) {
      engines.add(node.id.name)
    }
  })
  return bindings
}

/**
 * ESLint flat-config plugin for consumers whose repos lint with ESLint
 * (this repo itself uses Biome plus the fhirpath-check CLI). Checks every
 * literal FHIRPath expression with the spec §11 analyzer and the R4 model:
 * the fhirpath tag, the expression-first calls (compile, evaluate, ...), and
 * the FhirPathEngine helpers (test, filter, project, checkConstraints)
 * including expressions inside columns objects and constraint arrays. Which
 * calls count is the shared policy's decision (`isCheckedCall`): foreign
 * imports are skipped, and the common-name helpers (test/filter/first/project)
 * fire only on receivers bound to this package or to a
 * `new FhirPathEngine(...)` local.
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
    let bindings: SourceBindings = { foreign: new Set(), engines: new Set() }
    const checkAt = (node: NodeLike, expression: string): void => {
      for (const diagnostic of analyzeExpression(expression, { model: r4Model })) {
        if (node.loc) {
          context.report({ loc: node.loc, message: `[${diagnostic.code}] ${diagnostic.message}` })
        }
      }
    }
    return {
      Program(node) {
        bindings = collectBindings(node as unknown as NodeLike)
      },
      TaggedTemplateExpression(node) {
        const tag = node.tag
        const name = tag.type === 'Identifier' ? tag.name : undefined
        if (
          name === TAG_NAME &&
          !bindings.foreign.has(name) &&
          node.quasi.expressions.length === 0 &&
          node.quasi.quasis[0]
        ) {
          // Report on the template literal, like the call shapes report on their literals.
          checkAt(node.quasi as unknown as NodeLike, node.quasi.quasis[0].value.cooked ?? '')
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
        const argument = policy && (node.arguments[policy.argIndex] as NodeLike | undefined)
        if (
          name === undefined ||
          policy === undefined ||
          argument === undefined ||
          !isCheckedCall(policy, name, receiverRoot(callee as NodeLike), bindings)
        ) {
          return
        }
        for (const entry of expressionEntries(argument, policy.shape, estreeAst)) {
          checkAt(entry.node, entry.expression)
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
