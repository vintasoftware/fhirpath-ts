# A base is a DTO; the kind follows the subclass

Resource DTOs share columns such as `id` and `meta.lastUpdated`. They inherit
them through `defineDto('Condition', { base: ResourceDto })`, where the base is
itself a DTO defined on an ancestor root (`Resource`, `DomainResource`, or any
model supertype). The base's columns keep the types inferred on the ancestor;
the subclass's own columns infer on its root. A DTO accepts only a DTO as base;
a view accepts a DTO or a view. DTO columns are the stricter subset (no `as`, no
`choices`), so a view base could carry conversions into a DTO, while a DTO base
is valid in both.

## Considered options

- A third, kind-neutral "column set" definer: not projectable or registrable on
  its own, and one more concept to document. A DTO on `Resource` is already a
  useful thing: it projects any resource and registers `id()` for every focus.
- A re-rooting static (`ResourceDto.on('Condition')`): inheritance-shaped, but
  it moves `env`/`vars` to a second place and costs more at the type level.
- A generic factory returning `ViewBaseClass` (the previous recipe): works, but
  needs a declared return type for emitted declarations and `type:` on every
  base column, because inference cannot run on a generic root.
