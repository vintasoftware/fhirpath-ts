import { compile, type TypedValue } from '../../src/index.ts'
import { r4Model } from '../../src/r4/index.ts'

/** A typed focus survives moving from the response root to an item or answer. */
export interface Focus {
  root: unknown
  values: TypedValue[]
  env: Record<string, unknown>
  bindings: Record<string, TypedValue[]>
}

export function responseFocus(response: unknown, questionnaire: unknown): Focus {
  return {
    root: response,
    values: compile('$this').evaluateTyped(response, { model: r4Model }),
    env: { resource: response, rootResource: response, questionnaire },
    bindings: {},
  }
}

export function evaluateFocus(expression: string, focus: Focus): TypedValue[] {
  return compile(expression).evaluateTyped(focus.values, {
    model: r4Model,
    env: focus.env,
    vars: focus.bindings,
  })
}
