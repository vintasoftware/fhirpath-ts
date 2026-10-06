# Generated interfaces keep FHIR min=1 elements required

The generated R4 interfaces used to mark every element optional, on the view
that data read from a server may be incomplete. That made a column result such
as `address.first()` unassignable to the same type in `@medplum/fhirtypes`,
whose `Extension.url` is required, so clients cast every datatype they handed
on. The generator now keeps elements with FHIR minimum cardinality 1 required,
the claim medplum and the FHIR specification make about conformant data.
Inference results stay sound under that claim; a client that reads
non-conformant data already has to validate it.

The code unions follow the same rule as medplum's generator, because the
target of the assignability is medplum's type: a `required` or `extensible`
binding to a code system the bundled definitions enumerate becomes the union,
with no size cap, and an element bound to the resource-types value set
(`Reference.type`) becomes the union of resource names.

## Consequences

- The interfaces also type the input of root-prefixed expressions through
  `FhirpathInput`, and declared host values through `envTypes`/`varTypes`.
  Inputs stay lenient (`Lenient`): the root pin plus the resource with every
  element optional and every code widened to `string`, so a fixture such as
  `{ resourceType: 'Observation' }` still compiles for
  `r4.evaluate('Observation.status', ...)`, a misspelled property is still
  rejected, and a medplum value whose `Reference.type` names a medplum-only
  resource is still accepted. Only results carry the required elements and the
  code unions.
- Datatypes assign to the medplum types without a cast. Whole resources do not:
  `contained` and `Bundle.entry.resource` stay `{ resourceType: string }` here,
  while medplum's `Resource` is a closed union that also names medplum's own
  resources. Keeping those slots open is what lets a medplum resource be an
  input.
- A client that constructs a generated type by hand must now supply required
  elements. The interfaces are not re-exported, so this affects only inferred
  column results that are written back.
- `docs/api.md` no longer states that every generated field is optional.
