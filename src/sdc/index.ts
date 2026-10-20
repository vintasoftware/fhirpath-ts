/**
 * Variables and contexts that Structured Data Capture (SDC) defines for
 * expressions in a Questionnaire:
 * https://build.fhir.org/ig/HL7/sdc/en/expressions.html#fhirpath-supplements
 *
 * Each context is a typed value, so evaluating at it gives `%context` as the
 * QuestionnaireResponse item and `%resource` as the QuestionnaireResponse, as
 * SDC requires. Named `variable` extensions and launch contexts are the host's
 * to evaluate and bind through `vars`.
 */
import type { EvaluateOptions } from '../api/compile.ts'
import { FhirPathTypeError } from '../errors.ts'
import type { TypedValue } from '../values/typed-value.ts'

/** The engine calls these helpers make. A `FhirPathEngine` with a FHIR model, such as `r4`, has them. */
export interface SdcEngine {
  evaluateTyped(expression: string, input?: unknown, options?: EvaluateOptions): TypedValue[]
}

/**
 * `%questionnaire`, and `%qitem` for a context inside an item. Pass them as
 * `vars`; a type alias, unlike an interface, assigns to the `vars` record.
 */
export type SdcVars = {
  questionnaire: TypedValue[]
  qitem?: TypedValue[]
}

/** One place an SDC expression runs: the evaluation input and its variables. */
export interface SdcContext {
  context: TypedValue[]
  vars: SdcVars
}

/** One Questionnaire's SDC variables, read once for every context of its responses. */
export interface SdcScope {
  /**
   * `%questionnaire` and `%qitem` for `context`, a QuestionnaireResponse or
   * one of its items as typed values, such as a `templateExtractContext`
   * result. `%qitem` is the Questionnaire item with the context item's linkId,
   * at any depth. Throws when the linkId is not in the Questionnaire.
   */
  vars(context: readonly TypedValue[]): SdcVars
  /**
   * Every context of a QuestionnaireResponse in SDC evaluation order: the
   * response itself, then each item depth-first, including items nested under
   * answers. Each instance of a repeated item is its own context, so its
   * answers and nested items stay apart from the other instances'.
   */
  contexts(questionnaireResponse: unknown): Generator<SdcContext>
}

/** Read a Questionnaire's items once, for the variables of every context of its responses. */
export function sdcScope(engine: SdcEngine, questionnaire: unknown): SdcScope {
  const typed = engine.evaluateTyped('$this', questionnaire)
  const items = questionnaireItems(engine, typed)
  const vars = (context: readonly TypedValue[]) => varsFor(context, typed, items)
  return {
    vars,
    *contexts(questionnaireResponse) {
      const root = engine.evaluateTyped('$this', questionnaireResponse)
      yield { context: root, vars: vars(root) }
      const pending = engine.evaluateTyped('item.combine(answer.item)', root).reverse()
      for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
        const context = [item]
        yield { context, vars: vars(context) }
        pending.push(...engine.evaluateTyped('item.combine(answer.item)', context).reverse())
      }
    },
  }
}

function questionnaireItems(engine: SdcEngine, questionnaire: TypedValue[]): Map<string, TypedValue> {
  const items = new Map<string, TypedValue>()
  for (const item of engine.evaluateTyped('repeat(item)', questionnaire)) {
    const linkId = linkIdOf(item)
    if (linkId === undefined) continue
    if (items.has(linkId)) throw new FhirPathTypeError(`The Questionnaire repeats linkId '${linkId}'`)
    items.set(linkId, item)
  }
  return items
}

function varsFor(
  context: readonly TypedValue[],
  questionnaire: TypedValue[],
  items: ReadonlyMap<string, TypedValue>
): SdcVars {
  const linkIds = [...new Set(context.map(linkIdOf))]
  if (linkIds.every(linkId => linkId === undefined)) return { questionnaire }
  const [linkId] = linkIds
  if (linkIds.length !== 1 || linkId === undefined) {
    throw new FhirPathTypeError('An SDC context holds the items of one linkId')
  }
  const qitem = items.get(linkId)
  if (qitem === undefined) throw new FhirPathTypeError(`The Questionnaire has no item with linkId '${linkId}'`)
  return { questionnaire, qitem: [qitem] }
}

function linkIdOf(item: TypedValue): string | undefined {
  if (!item.type.endsWith('.item')) return undefined
  const linkId = (item.value as { linkId?: unknown } | null)?.linkId
  return typeof linkId === 'string' ? linkId : undefined
}
