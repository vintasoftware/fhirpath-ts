import type { Rule } from 'eslint'
import type * as ESTree from 'estree'

import { analyzeSite, type DeclaredFunction, type DeclaredVariable } from '../analyzer/analyze.ts'
import {
  CALL_SITES,
  type CallSitePolicy,
  type ClassHeritage,
  columnFunctionDeclaration,
  columnVocabulary,
  constructsEngine,
  type DeclaredColumnFunction,
  DTO_BASE_NAME,
  dtoRootsOf,
  type ExpressionAst,
  expressionEntries,
  isCheckedCall,
  isCheckedTag,
  isForeignModule,
  type LocalModuleOptions,
  rootOf,
  type SiteContext,
  siteContext,
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
  boolean: node => (node.type === 'Literal' && typeof node.value === 'boolean' ? node.value : undefined),
  properties: node =>
    node.type === 'ObjectExpression'
      ? node.properties.flatMap(property =>
          property.type === 'Property' ? [{ name: propertyKeyName(property), value: property.value }] : []
        )
      : undefined,
  elements: node => (node.type === 'ArrayExpression' ? node.elements.filter(element => element !== null) : undefined),
}

/** Add every identifier a binding pattern declares (`x`, `{ r4 }`, `[a, ...rest]`, `x = 1`). */
function addPatternNames(pattern: ESTree.Pattern, into: Set<string>): void {
  switch (pattern.type) {
    case 'Identifier':
      into.add(pattern.name)
      return
    case 'ObjectPattern':
      for (const property of pattern.properties) {
        addPatternNames(property.type === 'RestElement' ? property.argument : property.value, into)
      }
      return
    case 'ArrayPattern':
      for (const element of pattern.elements) {
        if (element) {
          addPatternNames(element, into)
        }
      }
      return
    case 'AssignmentPattern':
      addPatternNames(pattern.left, into)
      return
    case 'RestElement':
      addPatternNames(pattern.argument, into)
      return
    default:
      // A MemberExpression target does not declare a new name.
      return
  }
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
 * The name a callee or tag is known by: its own identifier, or the property of a
 * member access (`fhirpath` in `api.fhirpath`). Every place that resolves a name
 * uses this one — calls, `` fhirpath`…` `` tags, and a class's
 * `extends defineDto(…)` clause. They were three separate tests once, and the tag
 * and heritage copies rejected a member access the call copy accepted, so a
 * namespace-imported `api.fhirpath` tag and an `extends api.defineDto('Condition')`
 * root went unchecked here while `fhirpath-ts/sites` checked both.
 */
function nameOf(node: ESTree.Node): string | undefined {
  if (node.type === 'Identifier') {
    return node.name
  }
  return node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier'
    ? node.property.name
    : undefined
}

/** The name of the field a `@column(...)` decorator belongs to, from the call's ancestors. */
function decoratedFieldName(ancestors: readonly ESTree.Node[]): string | undefined {
  const member = ancestors.at(-2) as (ESTree.Node & { key?: ESTree.Node }) | undefined
  if (member?.type !== 'PropertyDefinition') {
    return undefined
  }
  const key = member.key
  if (key?.type === 'Identifier') {
    return key.name
  }
  return key !== undefined && isStringLiteral(key) ? key.value : undefined
}

/** A class's heritage, as `dtoRootsOf` reads it: its own DTO root, or the name of the class it extends. */
function heritageOf(node: ESTree.ClassDeclaration | ESTree.ClassExpression): ClassHeritage {
  const base = node.superClass
  const rootArgument =
    base?.type === 'CallExpression' && nameOf(base.callee) === DTO_BASE_NAME ? base.arguments[0] : undefined
  return {
    name: node.id?.name,
    ownRoot: rootArgument === undefined ? undefined : estreeAst.string(rootArgument)?.expression,
    baseName: base?.type === 'Identifier' ? base.name : undefined,
  }
}

/**
 * The heritage of the nearest enclosing class — what a `@column` field's
 * expressions analyze against, once `dtoRootsOf` has resolved it against the rest
 * of the file. Undefined when the field is not inside a class at all.
 */
function enclosingClass(ancestors: readonly ESTree.Node[]): ClassHeritage | undefined {
  for (let index = ancestors.length - 1; index >= 0; index--) {
    const node = ancestors[index]
    if (node?.type === 'ClassDeclaration' || node?.type === 'ClassExpression') {
      return heritageOf(node)
    }
  }
  return undefined
}

/**
 * ESLint flat-config plugin that checks every literal FHIRPath expression with
 * the spec §11 analyzer and the R4 model. Which call sites carry expressions,
 * and which are skipped, is the shared policy's decision — see
 * src/analyzer/expression-policy.ts.
 *
 * By default only the FHIRPath API imported from `fhirpath-ts` — or used bare,
 * without an import — is checked, so a local `compile` from another module is
 * left alone. Two options widen that:
 *   - `packages`: extra import-source prefixes to treat as the FHIRPath API.
 *   - `localImports`: also treat relative imports as the FHIRPath API, so the
 *     package can dogfood this rule on its own source (which imports relatively).
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
    schema: [
      {
        type: 'object',
        properties: {
          packages: { type: 'array', items: { type: 'string' } },
          localImports: { type: 'boolean' },
          // Host-supplied environment variables and functions the checked code
          // passes at runtime — AnalyzeOptions.variables / AnalyzeOptions.functions.
          variables: { type: 'object' },
          functions: { type: 'object' },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const options = (context.options[0] ?? {}) as LocalModuleOptions & {
      variables?: Record<string, DeclaredVariable>
      functions?: Record<string, DeclaredFunction>
    }
    // Candidate sites are collected during ESLint's own traversal and decided in
    // Program:exit, because the bindings that gate them (imports, engine locals)
    // can appear after the calls they gate — a module-scope engine used by an
    // earlier function.
    const foreign = new Set<string>()
    const trusted = new Set<string>()
    const rebound = new Set<string>()
    const engineLocals: { localName: string; className: string }[] = []
    const reboundFunction = (node: { id?: ESTree.Identifier | null | undefined; params: ESTree.Pattern[] }): void => {
      if (node.id) {
        rebound.add(node.id.name)
      }
      for (const param of node.params) {
        addPatternNames(param, rebound)
      }
    }
    const tags: { literal: ESTree.TemplateLiteral; expression: string; receiverRoot: string | undefined }[] = []
    const calls: {
      policy: CallSitePolicy
      name: string
      receiverRoot: string | undefined
      argument: ESTree.Node
      /** The call itself, for the argument that may name the type it runs against. */
      node: ESTree.CallExpression
      /** The class the call sits in, resolved to a root once the whole file is known. */
      enclosing: ClassHeritage | undefined
    }[] = []
    /** Every class in the file, so a DTO root can be followed through a base class. */
    const classes: ClassHeritage[] = []
    /**
     * One entry per `@column` field in the file. Any expression can call a
     * registered DTO column, so this is what lets calls between a file's own
     * columns resolve. It is filled in `Program:exit` because a declaration
     * carries the `fhirType` of the class it sits in, and a base class may be
     * declared further down the file. The call sites themselves are decided
     * there for the same reason.
     */
    const columnDeclarations: {
      kind: 'column' | 'criteria'
      field: string
      options: ESTree.Node | undefined
      enclosing: ClassHeritage | undefined
    }[] = []
    const columnFunctions: Record<string, DeclaredColumnFunction> = {}
    const checkAt = (node: ESTree.Node, expression: string, site: SiteContext = {}): void => {
      // ESLint severity comes from the rule's configuration, not per report, so
      // only error-severity diagnostics are reported; analyzer warnings (style
      // and possible-mistake findings) don't fail a lint run.
      const diagnostics = analyzeSite(
        {
          expression,
          ...site,
          // The file's whole column vocabulary, shared by every site in it.
          ...(Object.keys(columnFunctions).length > 0 && { functions: columnFunctions }),
        },
        {
          model: r4Model,
          ...(options.variables !== undefined && { variables: options.variables }),
          ...(options.functions !== undefined && { functions: options.functions }),
        }
      )
      for (const diagnostic of diagnostics) {
        if (diagnostic.severity === 'error') {
          context.report({ node, message: `[${diagnostic.code}] ${diagnostic.message}` })
        }
      }
    }
    return {
      ImportDeclaration(node) {
        if (typeof node.source.value !== 'string') {
          return
        }
        const names = isForeignModule(node.source.value, options) ? foreign : trusted
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
        } else {
          addPatternNames(node.id, rebound)
        }
      },
      FunctionDeclaration: reboundFunction,
      FunctionExpression: reboundFunction,
      ArrowFunctionExpression: reboundFunction,
      ClassDeclaration(node) {
        classes.push(heritageOf(node))
        if (node.id) {
          rebound.add(node.id.name)
        }
      },
      ClassExpression(node) {
        classes.push(heritageOf(node))
        if (node.id) {
          rebound.add(node.id.name)
        }
      },
      CatchClause(node) {
        if (node.param) {
          addPatternNames(node.param, rebound)
        }
      },
      TaggedTemplateExpression(node) {
        if (nameOf(node.tag) === TAG_NAME && node.quasi.expressions.length === 0 && node.quasi.quasis[0]) {
          // Report on the template literal, like the call shapes report on their literals.
          tags.push({
            literal: node.quasi,
            expression: node.quasi.quasis[0].value.cooked ?? '',
            receiverRoot: receiverRoot(node.tag),
          })
        }
      },
      CallExpression(node) {
        const callee = node.callee
        const name = nameOf(callee)
        const policy = name === undefined ? undefined : CALL_SITES.get(name)
        const argument = policy && node.arguments[policy.argIndex]
        if (name === undefined || policy === undefined || argument === undefined) {
          return
        }
        // Only the DTO decorators need to look up: the class they sit in, and the
        // field they decorate.
        const ancestors =
          policy.rootFromClass === true || policy.declaresField !== undefined
            ? context.sourceCode.getAncestors(node)
            : []
        const declares = policy.declaresField
        if (declares !== undefined) {
          const field = decoratedFieldName(ancestors)
          if (field !== undefined) {
            columnDeclarations.push({
              kind: declares,
              field,
              options: node.arguments[1],
              enclosing: enclosingClass(ancestors),
            })
          }
        }
        calls.push({
          policy,
          name,
          receiverRoot: receiverRoot(callee),
          argument,
          node,
          enclosing: policy.rootFromClass === true ? enclosingClass(ancestors) : undefined,
        })
      },
      'Program:exit'() {
        const bindings: SourceBindings = { foreign, trusted, rebound }
        // All imports are known now; resolve engine locals in source order, like
        // the CLI walker. A `new` local of some other class is a re-binding.
        for (const { localName, className } of engineLocals) {
          if (constructsEngine(className, bindings)) {
            trusted.add(localName)
          } else {
            rebound.add(localName)
          }
        }
        const dtoRoots = dtoRootsOf(classes)
        // Build the column names first. `checkAt` reads them, and every site in
        // the file shares them, including the tags.
        Object.assign(
          columnFunctions,
          columnVocabulary(
            columnDeclarations.map(({ kind, field, options: columnOptions, enclosing }) => ({
              field,
              declaration: columnFunctionDeclaration<ESTree.Node>(
                kind,
                columnOptions,
                estreeAst,
                rootOf(enclosing, dtoRoots)
              ),
            }))
          )
        )
        for (const tag of tags) {
          if (isCheckedTag(tag.receiverRoot, bindings)) {
            checkAt(tag.literal, tag.expression)
          }
        }
        for (const call of calls) {
          if (!isCheckedCall(call.policy, call.name, call.receiverRoot, bindings)) {
            continue
          }
          const site = siteContext<ESTree.Node>(
            call.policy,
            index => call.node.arguments[index],
            rootOf(call.enclosing, dtoRoots),
            estreeAst
          )
          for (const entry of expressionEntries(call.argument, call.policy.shape, estreeAst)) {
            checkAt(entry.node, entry.expression, site)
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
