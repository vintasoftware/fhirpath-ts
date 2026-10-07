# Generated interfaces keep FHIR min=1 elements required

The generated R4 interfaces used to mark every element optional, on the view
that data read from a server may be incomplete. That made a column result such
as `address.first()` unassignable to the same type in `@medplum/fhirtypes`,
whose `Extension.url` is required, so clients cast every datatype they handed
on. The generator now keeps elements with FHIR minimum cardinality 1 required,
the claim medplum and the FHIR specification make about conformant data.
Inference results stay sound under that claim; a client that reads
non-conformant data already has to validate it.

The interfaces enumerate every `required` or `extensible` `code` binding the
bundled definitions can list, with no size cap, and type `Reference.type` as
the union of the concrete resource names. That is a superset of what medplum's
generator enumerates (medplum leaves `DataRequirement.type`,
`ParameterDefinition.type`, and the TestScript `resource` elements as
`string`), so a generated value assigns to the medplum type. Inference claims
less: a navigated code infers the union only for a required binding, since an
extensible one admits other codes and medplum data puts its own resource names
in `Reference.type`.

## Consequences

- The interfaces also type the input of root-prefixed expressions through
  `FhirpathInput`, and declared host values through `envTypes`/`varTypes`.
  Inputs stay lenient (`Lenient`, one rule for every input site through
  `InputOf`): the root pin plus the resource with every element optional, so a
  fixture such as `{ resourceType: 'Observation' }` still compiles for
  `r4.evaluate('Observation.status', ...)` and a misspelled property is still
  rejected. A code keeps its union on input, so a misspelled status is rejected
  too; only a code set that names resources (`Reference.type`,
  `DataRequirement.type`) widens to `string`, which is what admits a medplum
  value whose `Reference.type` names a medplum-only resource and medplum's
  `string` for the broad lists.
  Only results carry the required elements.
- Datatypes assign to the medplum types without a cast. Whole resources do not:
  `contained` and `Bundle.entry.resource` stay `{ resourceType: string }` here,
  while medplum's `Resource` is a closed union that also names medplum's own
  resources. Keeping those slots open is what lets a medplum resource be an
  input.
- A client that constructs a generated type by hand must now supply required
  elements. The interfaces are not re-exported, so this affects only inferred
  column results that are written back.
- `docs/api.md` no longer states that every generated field is optional.
