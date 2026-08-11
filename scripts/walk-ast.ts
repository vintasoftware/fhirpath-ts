import type { AstNode } from '../src/parser/ast.ts'

export function walkAst(root: AstNode, visit: (node: AstNode) => void): void {
  visit(root)
  switch (root.kind) {
    case 'null':
    case 'boolean':
    case 'string':
    case 'number':
    case 'date':
    case 'dateTime':
    case 'time':
    case 'quantity':
    case 'identifier':
    case 'special':
    case 'external':
      return
    case 'dot':
      walkAst(root.left, visit)
      walkAst(root.right, visit)
      return
    case 'indexer':
      walkAst(root.target, visit)
      walkAst(root.index, visit)
      return
    case 'call':
      for (const argument of root.args) walkAst(argument, visit)
      return
    case 'unary':
      walkAst(root.operand, visit)
      return
    case 'binary':
      walkAst(root.left, visit)
      walkAst(root.right, visit)
      return
    case 'typeOp':
      walkAst(root.operand, visit)
      return
  }
}
