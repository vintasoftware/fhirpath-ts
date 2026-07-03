import { type TypedValue, typeLocalName } from '../values/typed-value'
import { registerFunction } from './registry'

/**
 * type() reflection (spec §10.2, STU). Returns one TypeInfo per item; the official
 * tests only inspect `namespace` and `name`, so ClassInfo element lists are not
 * materialized.
 */
registerFunction('type', {
  minArity: 0,
  maxArity: 0,
  evaluate: (context, input) => input.map(item => typeInfoOf(item, context.model?.namespace)),
})

function typeInfoOf(item: TypedValue, modelNamespace: string | undefined): TypedValue {
  const separator = item.type.lastIndexOf('.')
  const namespace = separator === -1 ? (modelNamespace ?? 'FHIR') : item.type.slice(0, separator)
  const name = typeLocalName(item.type)
  const isSystem = namespace === 'System'
  return {
    type: isSystem ? 'System.SimpleTypeInfo' : 'System.ClassInfo',
    value: { namespace, name },
  }
}
