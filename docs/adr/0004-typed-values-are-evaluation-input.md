# Typed values are evaluation input; context resources come from ancestry

SDC hosts such as Smart Forms evaluate expressions at a
`QuestionnaireResponse.item`, or at a value an earlier expression returned. Raw
JSON input loses the backbone type, choice elements, `_field` metadata, and the
link to the containing resource. The single-evaluation methods (`evaluate`,
`evaluateTyped`, `first`, `test`, their async and compiled forms) now accept
the typed values `evaluateTyped()` returns as input, as Firely accepts a scoped
node. `$this` and `%context` are those values. `%resource` is their owning
resource, and `%rootResource` is the container of a contained owning resource.
Both are read from the ancestry the engine already records. Inside a Bundle,
`%resource` is the entry's resource, never the Bundle. An explicit `env` value
still overrides both.

The engine recognises a typed value by its private ancestry field, never by its
shape: `Identifier` JSON also has `type` and `value`. `engine.toTyped(raw,
type, { in: resource })` types a raw element by finding it, by object
identity, inside `resource`. If the type found there conflicts with `type`,
it throws. Without `in`, the element is typed with no ancestry, and then
`%resource` and `%rootResource` throw when they are read. A declared root
(`compile(expr, type)`) checks the types of typed input and throws on a
conflict. It never converts raw input.

## Considered options

- **fhirpath.js `{base, expression}`.** It labels raw data with a type, but it
  does not check the data or give a parent, so `%resource`, `resolve('#id')`,
  and `weight()` still need the host to supply them.
- **An explicit focus / resource / rootResource triple (HL7 Java).** The caller
  passes every resource by hand. HAPI and StructureMap callers drop these
  arguments, which then fail, and contained `resolve()` still needs a host
  hook.
- **A wrapper type (`engine.context(items, type)`).** This adds one more
  concept, and the ancestry of a typed value already gives what the wrapper
  would carry.

## Consequences

- At the type level, typed input has an opaque root. A declared backbone root
  types `%resource` as the resource its path starts with. A declared datatype
  root types `%resource` as opaque. `%rootResource` is always opaque for a
  non-resource root.
- `pathname()` starts its paths at the derived `%rootResource`, as the
  FHIRPath STU text defines it. Inside a Bundle entry the path starts at the
  entry's resource, not at the Bundle. fhirpath.js and Firely `Location` start
  at the top ancestor instead. An `env` override does not change where the path
  starts.
- DTO projection does not accept typed values. Its structural input type
  (ADR 0001) stays as it is.
