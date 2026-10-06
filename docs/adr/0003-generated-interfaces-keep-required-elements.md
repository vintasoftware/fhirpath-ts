# Generated interfaces keep FHIR min=1 elements required

The generated R4 interfaces used to mark every element optional, on the view
that data read from a server may be incomplete. That made a column result such
as `address.first()` unassignable to the same type in `@medplum/fhirtypes`,
whose `Extension.url` is required, so clients cast every datatype they handed
on. The generator now keeps elements with FHIR minimum cardinality 1 required,
the claim medplum and the FHIR specification make about conformant data.
Inference results stay sound under that claim; a client that reads
non-conformant data already has to validate it.

## Consequences

- The interfaces also type the input of root-prefixed expressions through
  `FhirpathInput`. Inputs stay lenient: `FhirpathInput` becomes the root pin
  plus a deep partial of the resource, so a fixture such as
  `{ resourceType: 'Observation' }` still compiles for
  `r4.evaluate('Observation.status', ...)` and a misspelled property is still
  rejected. Only results carry the required elements.
- A client that constructs a generated type by hand must now supply required
  elements. The interfaces are not re-exported, so this affects only inferred
  column results that are written back.
- `docs/api.md` no longer states that every generated field is optional.
