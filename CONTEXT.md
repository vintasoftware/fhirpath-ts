# fhirpath-ts

A FHIRPath engine for TypeScript whose expressions are typed at compile time and
checked statically, plus the DTO layer that reads FHIR resources through those
expressions.

## Language

### Reading resources

**Root**:
The FHIR type a DTO, view, or expression navigates from.
_Avoid_: resource type (a root may be a datatype), context type

**Input**:
The value handed to a projection. For a resource root it carries that root's
`resourceType`; for a datatype root it is any object.
_Avoid_: subject, source, payload

**Projection**:
Reading an input through a DTO or view into one row per resource.
_Avoid_: mapping, hydrating, constructing, building

**Defining engine**:
The engine a DTO or view was defined on. A DTO projects on it, or on an engine
derived from it.

### DTOs

**DTO**:
A class defined on an engine whose fields are columns over one root. It can be
projected and registered, so its columns are also callable as functions.
_Avoid_: model, entity, record, view model

**View**:
A DTO that can only be projected. A view's columns may convert values; a DTO's
may not.
_Avoid_: projection class, read model

**Column**:
A field of a DTO or view that holds one FHIRPath expression over the root.
_Avoid_: field (the TypeScript term), property, attribute

**Criteria**:
A column whose value is one boolean, where an empty result counts as `false`.
_Avoid_: flag, predicate column, test column

**Required column**:
A column on a singular path that the input must carry, so its value is never
`undefined`. The requirement is on the input, not a check at read time.
_Avoid_: mandatory, non-null, non-optional, asserted column

**Base**:
A DTO whose root is an ancestor of another DTO's root and whose columns that DTO
inherits. A DTO takes a DTO as base; a view takes a DTO or a view.
_Avoid_: mixin, parent view, column set, trait

**Registering**:
Deriving a new engine on which expressions can call a DTO's columns as
functions. Registering never changes the engine it derives from.
_Avoid_: installing, mounting, extending the engine
