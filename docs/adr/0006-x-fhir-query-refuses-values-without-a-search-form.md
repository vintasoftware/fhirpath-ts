# x-fhir-query refuses values without a search form; hosts may evaluate its expressions

An x-fhir-query is a FHIR search string with FHIRPath expressions in `{{ }}`.
SDC hosts fill one for extraction contexts, `$populate`, answer and candidate
expressions, and launch contexts, and then send the search to a server. The
URL that results leaves the host: servers, proxies, and access logs keep it.

Each result becomes its search form: text for a primitive, `system|code` for
a Coding, `value|system|code` for a Quantity, and so on. A result whose type
has no search form, such as a `HumanName`, `Address`, or JSON of no type,
throws a `FhirPathTypeError` that names the type, never the value. Inside
each value, a `\` goes before `\`, `$`, `,`, and `|`, as FHIR search escaping
says, and then the value is percent-encoded. A `,` or `|` in the data then
cannot add a value or a system, and a `&` cannot add a parameter. A canonical
keeps its `|version`, which is the version separator of a search.

`compileXFhirQuery(query)` keeps the parts apart: `expressions` gives the
compiled embedded expressions, and `substitute(results)` takes each one's
typed results. `evaluate()` and `evaluateXFhirQuery()` join the two for a
host with no further needs.

## Considered options

- **Write every value, as Medplum's `stringifyTypedValue` does.** It formats a
  HumanName as a display name and writes any other unlisted type as the JSON of
  the whole value. A mistyped expression such as `{{ %patient.address }}` then
  puts the patient's address into a URL. The search also cannot match on that
  JSON, so writing it gives a wrong result where an error would show the
  mistake.
- **Skip a value with no search form.** This also keeps data out of the URL,
  but it hides a mistake in the expression: the search runs as if the
  expression had found nothing, and an empty `code=` matches every code.
- **Medplum's empty-unless-single rule.** Medplum writes nothing when an
  expression gives zero or several results. The R5 x-fhir-query page lists
  several results as a comma-separated list, which FHIR search reads as OR.
- **Percent-encoding without search escaping, as Medplum and Smart Forms
  do.** A server decodes `%2C` back to `,` before it reads the separators, so
  an Identifier value `a,b` would search for `a` or `b`. Escaping means a
  string built as `system|code` text is one escaped value; an expression
  returns a Coding or Identifier for a token.
- **Only a one-call form that evaluates and substitutes.** SDC extraction
  evaluates each embedded expression on its own focus, with its own
  `%context`, variables, static analysis, and an error report that names the
  expression. A one-call form would make such a host parse the query again.

## Consequences

- An expression whose result type has no search form fails at runtime. The
  analyzer does not check search forms; a host that analyzes the embedded
  expressions can compare their result types itself.
- The first value without a search form stops the substitution, so a host
  reports one refusal per query.
- A syntax error names the embedded expression by its position, counted from
  1, and keeps the expression's own syntax error as its `cause`, so a host
  can word its own report.
