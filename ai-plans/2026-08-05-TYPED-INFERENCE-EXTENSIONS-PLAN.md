# Typed-inference extensions: fixed-return batch 2, union groups, function registry

Three incremental extensions to the type-level FHIRPath inference in
`src/typed/infer.ts`, in implementation order. Each is independently shippable
and keeps the layer's contract: **never a type error, never a wrong type —
only imprecise**. Anything the parser cannot prove degrades to `unknown[]`.

## Context: the architecture you are extending

Read `src/typed/infer.ts` (~185 lines) before starting. Post-PR-#33 shape:

- **State** is a type-name string (possibly a union of names), `'opaque'`
  (the parse-failure sentinel), or the **broad `string` state** — the
  constraint-fallback `Navigate` produces for unknown elements. Two invariants
  are documented in the file and pinned by tests: fixed-return calls after the
  broad state keep their concrete types (matches the runtime's empty-input
  semantics), and `'opaque'` is never rescued.
- **`Step`** matches a segment once as `` `${Fn}(${Arg})` ``, guards `Arg`
  with `CleanArg` (quote-stripping + paren balance + rejection of `\` and
  `` ` ``), then dispatches on `Fn` through `Call` and the `FixedReturns`
  table. `select` is deliberately unguarded — its argument is re-parsed and
  the parse is the guard; a test pins both its soundness and its precision.
- **`StepAcrossParen`** rejoins segments whose parens contain dots. The first
  `).` closes the segment unless a second `(` opened before it.
- **Perf is CI-gated**: `pnpm check:type-perf` compares fixture
  (`src/typed/perf-fixture.types.ts`) instantiations against
  `scripts/type-perf-budget.json` (±5%). Every feature here must extend the
  fixture with its new constructs and re-baseline deliberately
  (`pnpm check:type-perf --update`), explaining the delta in the PR.
- **Test conventions** (`src/typed/infer.test.ts`): dual assertions — the
  inferred type and an executed runtime result must agree (run the runtime
  FIRST, then write the test); an adversarial "operator-glued segments"
  battery that every new construct must extend; regression pins for every
  deliberate design deviation.
- **History warning**: the two wrong-type incidents to date were (1) trailing
  operators swallowed by patterns ending in `)`/`]`, and (2) parens inside
  string literals fooling paren counting. Every new pattern must be attacked
  both ways before merging.

Relationship to `ai-plans/2026-07-07-TYPE-LEVEL-EXPRESSION-INFERENCE-PLAN.md`
(PR #15, full arktype-style parser): these three features are incremental
extensions of the current dispatch walker. If the full parser lands later, it
absorbs feature 2's parsing; feature 1's table and feature 3's registry are
orthogonal and survive any parser. Update that plan if this one ships first.

---

## Feature 1: fixed-return batch 2 + identity functions

Grow the `FixedReturns` table and the identity (`where`-slot) list in `Call`.
Cheap and mechanical, but every entry is a soundness claim: the FixedReturns
invariant (documented on the interface) is that the type holds for **any**
input, including empty — these types also apply after the broad state.

### Candidate entries — verify EACH against `src/functions/*` and
`src/analyzer/signatures.ts` before adding; drop any that disagree

- `string`: `trim`, `upper`, `lower`, `replace`, `substring`, `encode`,
  `decode`, `escape`, `unescape`, `split` (collection of strings)
- `boolean`: `matches`, `startsWith`, `endsWith`, `contains` (the function —
  the operator spelling never parses as a call), `subsetOf`, `supersetOf`,
  `isDistinct`, `allTrue`, `anyTrue`, `allFalse`, `anyFalse`, `all`
- `integer`: `indexOf`, `ceiling`, `floor`, `truncate`
- `decimal`: `round`, `sqrt`, `exp`, `ln`, `log`
- identity (returns the input's own type): `distinct`, `tail`, `skip`,
  `take`, `exclude`, `intersect`, `trace`, `abs`

### Explicit DO-NOT-ADD list (result type depends on input)

`power` (integer^integer → integer, decimal → decimal), `lowBoundary`/
`highBoundary`, `combine`/`union` (argument-dependent), `children`/
`descendants`, `iif`, `aggregate`, `repeat`, `ofType` variants (already
special-cased), `first`/`last`/`single` (already identity).

### Design change: make the table a value

Convert the type-only interface into
`export const FIXED_RETURNS = {...} as const satisfies Record<string, keyof R4TypeOf & string>`
with `type FixedReturns = typeof FIXED_RETURNS`. Then add a unit test that
iterates `FIXED_RETURNS` and cross-checks each entry against the analyzer's
`FUNCTION_SIGNATURES` result types — the table can no longer silently drift
from the analyzer. Do the same for the identity list if practical.

### Tests

- Dual type+runtime assertions for at least one function per return type.
- Glued-operator battery entries for the new arg-taking functions
  (`replace('a', 'b') = ('x')` → `unknown[]`; `substring(0, 1)` currently
  degrades on main — it must now infer, so also verify the comma case:
  `CleanArg` must accept comma-separated arguments).
- Empty-input pins: `Patient.nope.matches('x')` → `boolean[]` (broad state).

### Acceptance

Table cross-check test green; full suite green; budget re-baselined with a
small justified delta. No dogfood annotations die from this feature alone —
it is groundwork.

---

## Feature 2: union groups and `%var` roots

The keystone: `(a | b | c)` groups and top-level `expr | expr` unions.

### Grammar (all-or-degrade; any doubt → `'opaque'`)

- `EXPR := TERM (‹|› TERM)*` at the top level of an expression, and
  `(EXPR).rest…` as a group segment — as the root or after a dot.
- Each `TERM` parses independently with the existing machinery (its own root
  resolution). The group's state is the **union of the term states**.
- Soundness rule: if ANY term is `'opaque'`, the whole union is `'opaque'`.
  Never union a known name with a failed parse.
- Splitting must be literal-aware and depth-aware: a `|` inside a string
  literal or inside parens must not split. Reuse the `CleanArg` toolkit:
  strip quoted spans first; track one paren level; bail to `'opaque'` on
  backslash/backtick, unpaired quotes, or nesting beyond one level. Validate
  each split term (balanced parens, paired quotes) before parsing it.

### `%var` roots enter the broad state

- `ParseRoot` maps a `` `%${string}` `` root to the broad `string` state
  (same state unknown elements produce). Fixed-return calls after it keep
  their types — `%rowIndex.toString()` → `string` — which is sound because
  fixed returns are input-independent.
- **Navigate change**: from the broad state, element navigation currently
  yields `'opaque'`. Change it to STAY broad (`string extends S` guard in
  `Navigate`). Rationale: a known-type element miss is a typo signal and must
  stay `'opaque'`-like; a broad-state miss is unknowable, and "unknowable" is
  exactly what broad means. This makes `%report.effective.….toString()` infer
  `string` while `%report.effective` alone stays `unknown[]`. Pin both
  behaviors with tests, and re-verify `Patient.nope.given` still degrades
  (known-type miss → broad on first hop, then broad stays broad — confirm the
  result is still `unknown[]` for plain navigation chains).

### Adversarial battery (mandatory before merge)

- `(A | B) = (C)`, `(A | B) | (C) = (D)`, groups with literals containing
  `|`, `(`, `)`; a group where one term is garbage; `(A | B).count() > (0)`;
  nested groups `((a | b) | c)` (degrade is fine, wrong type is not).
- Run the runtime for every case that infers a concrete type.

### Dogfood/README scorecard (expected annotation kills)

- `LabDTO.date` — `(DiagnosticReport.effective.ofType(dateTime) | DiagnosticReport.issued).first().toString()` → `string` ✓
- `LabResultDTO.date` — `%report` terms via broad state + trailing
  `.toString()` → `string` ✓
- `MedicationRequestDTO.routeText`'s inner `select(text | coding.display.first())`
  → `string` ✓ once the union works inside select's re-parse (verify — should
  be free since select re-enters `ParseSegments`)
- README's `%rowIndex.toString()` key example ✓
- NOT killed: `IdColumn` (`id` term is relative — root problem, feature 3 /
  factory territory), `displayText` (relative root), `PATIENT_DISPLAY_NAME`
  (`iif` inside `select` — out of scope), `medicationName` (custom function —
  feature 3).

### Perf

This is the riskiest feature for instantiations (every expression now runs a
union pre-scan). Add group-heavy fixture entries FIRST, measure the pre-scan
cost on plain dotted paths (the common case must not pay much — consider a
cheap `Expr extends \`${string}|${string}\`` gate before the full scanner),
and budget-gate the result.

---

## Feature 3: type-level function registry

Registered custom functions (`displayText()`, `medicationName()`, …) infer
their fixed result types at call sites, via the engine's type parameters.

### Core design

- Export `type StateOf<Expr extends string>` from `infer.ts` (the state-name
  result of `ParseRoot` — the NAME, not the TS type).
- `declareColumn` captures literals:
  `declareColumn<const Name extends string, const Expr extends string, …>` →
  `DeclaredColumn` carries `{ name: Name; state: StateOf<Expr> }`. Columns
  using `as:`/`map:`/`enum:` register as `'opaque'` — their result is a TS
  value outside the type-name space.
- `FhirPathEngine<Fns extends Record<string, string>>`: the constructor's
  `columns:` (and DTO capture, below) fold into
  `Fns = { [name]: stateName }`. Engine methods thread it:
  `FhirpathResult<Expr, Fns>` gains an optional second parameter defaulting to
  `{}`; `Call`'s final fallback becomes
  `Fn extends keyof Fns ? Fns[Fn] : 'opaque'` (a registry value may itself be
  `'opaque'` — that must flow through as opaque, not as a type name; add the
  guard and a test).
- Free-standing `compile()` / tagged `fhirpath\`\`` have no engine and keep
  the empty registry. Document this.

### DTO column capture — the hard part, decide explicitly

DTO classes lose expression literals: `column()` returns the value type, so
`InstanceType<Dto>` cannot yield state names. Options, in recommended order:

1. **Factory capture (recommended)**: introduce the `dto(root, columns)` /
   `columnsOf(root)` base-class factory (see the discussion in PR #34's
   lineage): the factory's `const C` generic holds the expression literals,
   and the factory attaches a phantom static
   (`declare static readonly __columns: C`) the engine constructor reads.
   This also solves relative roots (terms parse from the factory's root
   state) — which is what finally kills `displayText` when combined with
   feature 2, and `medicationName`/`doseText()`-family call sites.
2. **Field branding (fallback)**: `column()` returns
   `Value & { readonly [exprBrand]?: Expr }` — assignability to the plain
   value is preserved, `project()`'s `Projection` mapped type strips the
   brand from rows. Riskier: branded primitives are visible to
   `expectTypeOf`-style user code and in-class hovers. Prototype before
   committing.
3. **v1 punt**: registry covers `declareColumn` only; DTO-registered
   functions stay opaque. Acceptable first PR, but the dogfood scorecard is
   then nearly empty — most dogfood custom functions are DTO columns.

### Self-reference and cascades

A registered expression may call other registered functions
(`medicationName` calls `displayText()`). Computing `StateOf` with the full
registry while building the registry is a circular type. Stratify:

- v1: `StateOf<Expr>` computed with the EMPTY registry — self-contained
  expressions resolve; chained ones register as `'opaque'` (honest).
- v2 (optional, measure first): two fixed passes —
  `Fns1 = StateOf<…, {}>`, `Fns2 = StateOf<…, Fns1>`. Two passes cover every
  dogfood case (`medicationName` → `displayText` is depth 2). Never iterate
  to a fixpoint.

### Dogfood scorecard (with factory capture + feature 2)

`MedicationCardDTO.name`, `MedicationDetailDTO.name/dose/route/instructions`,
`ProblemDTO.name`, `LabDTO.name`, `displayText`, `medicationName` → all lose
`type: 'string'`. Remaining annotated after all three features: `%badge.*`
(app-shape boundary — correct to keep), `PATIENT_DISPLAY_NAME` and
`GroupColumn` (`iif` — out of scope), `IdColumn` unless the factory route
also types it (`id` from the factory root + feature-2 union → `string` ✓).

### Perf

Engine generics instantiate per method call; measure a DTO-heavy fixture
variant. The registry map itself is cheap (keyed lookup); the risk is `const`
inference over large `columns` arrays in the constructor.

---

## Cross-cutting requirements (all three features)

1. **Soundness first**: extend the operator-glued battery per feature; for
   every new concrete inference, execute the runtime and compare. A wrong
   type is a blocker; a degradation is a judgment call.
2. **Budget discipline**: fixture entries for each new construct; deliberate
   `--update` re-baselines with the delta explained in the PR.
3. **Docs**: module docstring subset list, README static-checking list, and
   the README `type:` prose ("outside the inference subset") must stay true
   after each feature.
4. **Invariant docs**: `FixedReturns` input-independence and the broad-state
   semantics are documented in `infer.ts` — extend them, don't contradict
   them. If feature 2's Navigate change lands, update the `Navigate` doc and
   the pinned tests together.
5. **Dogfood as acceptance**: each feature's PR should delete the dogfood
   annotations its scorecard predicts — that is the proof the feature works,
   and the dogfood analyzer test keeps the expressions honest at runtime.

---

## Implementation status (2026-08-05, this branch)

All three features shipped, with these deviations from the plan text:

- **Feature 1**: `abs` was dropped from the identity list (the analyzer
  declares its result unknown; the cross-check test enforces agreement).
  `lastIndexOf`, `matchesFull`, and `replaceMatches` were added (same
  families, analyzer-verified). `defineVariable` and `sort` joined the
  identity list in feature 3 (both `SAME` in the analyzer).
- **Feature 2**: the premise that broad-state navigation "currently yields
  'opaque'" was outdated — broad already stayed broad on main; the behavior
  is now explicit and pinned. A NEW wrong-type hole was found and fixed: an
  operator glued into a middle segment (`Patient.name and x.count()`) widened
  to broad and let the fixed-return tail claim `integer[]`; GluedName sends
  such segments to 'opaque' (miss-only, so the hot path never pays).
  StepAcrossParen was rewritten to scan `).` candidates with a quote-aware,
  depth-counting completeness check, which also made previously-degraded
  shapes precise (`select(given.first()).count()`, `join('(').length()`).
  `routeText` was NOT killable in this feature (its expression is relative to
  the DTO's fhirType — resolved by feature 3's registry/remap instead).
- **Feature 3**: DTO capture is NOT field branding — that option (2) was
  built first and rejected in review: the `'~fhirpathColumn'` phantom showed
  up in every field hover. Capture is `columnsOf(fhirType)` instead: a
  `column()` factory scoped to one resource or datatype, so relative chains
  infer at the declaration itself and fields hold plain value types —
  `project()` returns `InstanceType<Dto>` directly, with no row re-typing.
  The factory stamps its scope on each spec at runtime, making the class's
  `fhirType` static optional (derived via dtoFhirType; contradictions and
  mixed scopes throw). The type-level registry covers DECLARED COLUMNS only —
  their literal spec lives on the declaration object, needing no value brand;
  entries keep `{ in, out }` and the two fixed passes, so a declaration
  calling another declared function resolves. DTO-class column functions
  register at runtime and in the analyzer, not in the type system:
  `medicationName`-style calls declare their result with `type`. `doseText`
  (and columns calling it) stay annotated: `combine()` is argument-dependent.
