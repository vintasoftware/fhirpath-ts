# `%context` apart from the input is an `env` value

SDC template extraction evaluates an expression on a focus, such as one result
of a `templateExtractContext`, while `%context` stays the QuestionnaireResponse
item being extracted. The focus may lie outside the response: a Bundle that an
x-fhir-query search returned, or a copy of an item made for one answer. `env`
now binds typed values as they are, so `env: { context: item }` sets
`%context` apart from the input, where `$this` and relative paths start.
`%resource` and `%rootResource` still follow the input, and the host sets them
in `env` when the input is not inside the resource. An `env` value is
recognized as typed by the same brand as the input, never by its shape.

## Considered options

- **A `context` option from which `%resource` and `%rootResource` follow.** It
  matches FHIR's wording that `%resource` holds `%context`, but no engine
  surveyed does it. fhirpath.js, fhirpath-py, atomic-ehr, and Medplum let the
  environment override `%context`. HAPI and Firely set `%resource` from caller
  parameters, or from the input's ancestry with an override. A second option
  would also be a second place, beside `env`, that sets `%context`.
- **Typed values only in `vars`.** `vars` cannot take reserved names, so
  `%context`, `%resource`, and `%rootResource` would still have no typed route.

## Consequences

- `env` and `vars` both carry typed values. `env` binds host data, typed or
  JSON; `vars` binds expressions and pre-resolved collections, and can never
  take a reserved name.
- The type layer types an `env` value for `context`, `resource`, or
  `rootResource` from that value, not from the input, and a typed value as
  unknown.
- `pathname()` still starts at the input's `%rootResource`, so a typed `env`
  value from another evaluation has no path unless it shares that resource.
- The Smart Forms adapter passes fhirpath.js's environment variables through
  `env` unchanged.
