import { readFileSync } from 'node:fs'

import type { Rule } from 'eslint'
import type * as ESTree from 'estree'

import { analyzeSite, type DeclaredFunction, type DeclaredVariable } from '../analyzer/analyze.ts'
import {
  CALL_SITES,
  callExpressionCandidates,
  type CallSitePolicy,
  type ClassFactory,
  type ClassHeritage,
  columnFunctionDeclaration,
  constructsEngine,
  declaredColumnOverloads,
  DTO_BASE_NAME,
  dtoClassesOf,
  dtoClassOf,
  type ExpressionAst,
  type FileColumnFunction,
  isCheckedCall,
  isCheckedTag,
  isForeignModule,
  type LocalModuleOptions,
  type SiteContext,
  type SourceBindings,
  TAG_NAME,
} from '../analyzer/expression-policy.ts'
import { r4Model } from '../r4/index.ts'

function isStringLiteral(node: ESTree.Node): node is ESTree.SimpleLiteral & { value: string } {
  return node.type === 'Literal' && typeof node.value === 'string'
}

/**
 * Statically-known property key: `path` in `{ path: ... }`, `{ 'path': ... }`,
 * or `{ ['path']: ... }`; undefined for other computed keys.
 */
function propertyKeyName(property: ESTree.Property): string | undefined {
  if (property.computed) {
    return isStringLiteral(property.key) ? property.key.value : undefined
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
      ? node.properties.map(property =>
          property.type === 'Property'
            ? { name: propertyKeyName(property), value: property.value }
            : { name: undefined, value: property.argument, spread: true as const }
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

/** Returns an identifier name or the property name of a non-computed member access. */
function nameOf(node: ESTree.Node): string | undefined {
  if (node.type === 'Identifier') {
    return node.name
  }
  return node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier'
    ? node.property.name
    : undefined
}

/**
 * The public instance field a `this.<name>(...)` call initializes, when the call
 * is that field's whole initializer. Undefined for any other call shape.
 */
function initializedFieldName(call: ESTree.CallExpression, ancestors: readonly ESTree.Node[]): string | undefined {
  const field = ancestors.at(-1)
  if (
    call.callee.type !== 'MemberExpression' ||
    call.callee.object.type !== 'ThisExpression' ||
    field?.type !== 'PropertyDefinition' ||
    field.value !== call ||
    field.static
  ) {
    return undefined
  }
  if (field.computed) {
    return isStringLiteral(field.key) ? field.key.value : undefined
  }
  if (field.key.type === 'Identifier') {
    return field.key.name
  }
  return isStringLiteral(field.key) ? field.key.value : undefined
}

/** A class's heritage, as `dtoClassesOf` reads it. */
function heritageOf(node: ESTree.ClassDeclaration | ESTree.ClassExpression): ClassHeritage {
  return heritageOfBase(node.id?.name, node.superClass)
}

/** Reads one `extends` expression, or what a factory returns, for `dtoClassesOf`. */
function heritageOfBase(name: string | undefined, base: ESTree.Expression | null | undefined): ClassHeritage {
  const callee = base?.type === 'CallExpression' ? base.callee : undefined
  const extendsDefineDto = callee !== undefined && nameOf(callee) === DTO_BASE_NAME
  const rootArgument = extendsDefineDto && base?.type === 'CallExpression' ? base.arguments[0] : undefined
  return {
    name,
    extendsDefineDto,
    defineDtoNamespace: extendsDefineDto && callee?.type === 'MemberExpression' ? receiverRoot(callee) : undefined,
    ownRoot: rootArgument === undefined ? undefined : estreeAst.string(rootArgument)?.expression,
    baseName: base?.type === 'Identifier' ? base.name : undefined,
    baseCall: !extendsDefineDto && callee?.type === 'Identifier' ? callee.name : undefined,
    extendsOther:
      base !== null &&
      base !== undefined &&
      !extendsDefineDto &&
      base.type !== 'Identifier' &&
      callee?.type !== 'Identifier',
  }
}

/** What a function named `name` returns, when that is a class, a class name, or a class-building call. */
function factoryOf(name: string, body: ESTree.BlockStatement | ESTree.Expression): ClassFactory | undefined {
  const returned =
    body.type === 'BlockStatement'
      ? body.body.find((statement): statement is ESTree.ReturnStatement => statement.type === 'ReturnStatement')
          ?.argument
      : body
  if (returned?.type === 'ClassExpression') {
    return { name, builds: heritageOf(returned) }
  }
  return returned?.type === 'Identifier' || returned?.type === 'CallExpression'
    ? { name, builds: heritageOfBase(undefined, returned) }
    : undefined
}

/**
 * The heritage of the nearest enclosing class — what a column field's
 * expressions analyze against, once `dtoClassesOf` has resolved it against the
 * rest of the file. Undefined when the call is not inside a class at all.
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
 * ESLint rule for literal FHIRPath expressions. The shared source policy decides
 * which calls and tags count. `packages` adds trusted import prefixes, and
 * `localImports` trusts relative imports.
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
    // Decide candidate sites at Program:exit because imports and engine
    // declarations may appear after calls that depend on them.
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
      /** The call itself, for the argument that may name the type it runs against. */
      node: ESTree.CallExpression
      /** The class the call sits in, resolved to a root once the whole file is known. */
      enclosing: ClassHeritage | undefined
      /** The field a `this.<name>(...)` call initializes. */
      field: string | undefined
    }[] = []
    /** Every class in the file, so a DTO root can be followed through a base class. */
    const classes: ClassHeritage[] = []
    /** Every function that returns a class by name, so a factory-built DTO can be followed. */
    const factories: ClassFactory[] = []
    /**
     * The file's column vocabulary. Any expression can call a registered DTO
     * column, so this is what lets calls between a file's own columns resolve.
     * It is filled in `Program:exit` because a declaration carries the
     * `fhirType` of the class it sits in, and a base class may be declared
     * further down the file. The call sites themselves are decided there for
     * the same reason.
     */
    const columnFunctions: Record<string, FileColumnFunction> = {}
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
        const init = node.init
        if (
          node.id.type === 'Identifier' &&
          (init?.type === 'ArrowFunctionExpression' || init?.type === 'FunctionExpression')
        ) {
          const factory = factoryOf(node.id.name, init.body)
          if (factory !== undefined) {
            factories.push(factory)
          }
        }
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
      FunctionDeclaration(node) {
        reboundFunction(node)
        const factory = node.id ? factoryOf(node.id.name, node.body) : undefined
        if (factory !== undefined) {
          factories.push(factory)
        }
      },
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
        // Only DTO columns need to look up: the class they sit in, and the
        // field they initialize.
        const ancestors = policy.receiver === 'dto-field' ? context.sourceCode.getAncestors(node) : []
        calls.push({
          policy,
          name,
          receiverRoot: receiverRoot(callee),
          node,
          enclosing: policy.rootFromClass === true ? enclosingClass(ancestors) : undefined,
          field: policy.receiver === 'dto-field' ? initializedFieldName(node, ancestors) : undefined,
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
        const dtoClasses = dtoClassesOf(classes, bindings, factories)
        const checked = calls.flatMap(call => {
          const dto = dtoClassOf(call.enclosing, dtoClasses, bindings)
          const evidence = call.field !== undefined && dto !== undefined ? { dtoField: true as const } : {}
          return isCheckedCall(call.policy, call.name, call.receiverRoot, bindings, evidence) ? [{ call, dto }] : []
        })
        // Build the column names first. `checkAt` reads them, and every site in
        // the file shares them, including the tags.
        for (const { call, dto } of checked) {
          const declares = call.policy.declaresField
          if (declares !== undefined && call.field !== undefined) {
            columnFunctions[call.field] = declaredColumnOverloads(
              columnFunctions[call.field],
              columnFunctionDeclaration<ESTree.Node>(declares, call.node.arguments[1], estreeAst, dto?.root)
            )
          }
        }
        for (const tag of tags) {
          if (isCheckedTag(tag.receiverRoot, bindings)) {
            checkAt(tag.literal, tag.expression)
          }
        }
        for (const { call, dto } of checked) {
          for (const candidate of callExpressionCandidates<ESTree.Node>(
            call.policy,
            index => call.node.arguments[index],
            dto?.root,
            estreeAst
          )) {
            if (candidate.expression !== undefined) {
              checkAt(candidate.node, candidate.expression, candidate.context)
            }
          }
        }
      },
    }
  },
}

const { name: packageName, version: packageVersion }: { name: string; version: string } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
)

const plugin = {
  meta: { name: packageName, version: packageVersion },
  rules: {
    'no-invalid-expressions': noInvalidExpressions,
  },
}

export default plugin
