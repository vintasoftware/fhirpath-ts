# Benchmarks

Cross-engine performance comparison of **fhirpath-ts** against **fhirpath-rs**
([`octofhir-fhirpath`](https://crates.io/crates/octofhir-fhirpath), a
performance-focused Rust FHIRPath engine), run over a real test set: the official
HL7 R4 conformance corpus that ships in this repo (`test-data/official/r4`).

These are hand-run benchmarks, not part of CI. Numbers are relative and
machine-dependent — the point is the *shape* of the comparison and catching
regressions, not an absolute score.

## Quick start

```sh
benchmarks/run.sh
```

This extracts the workload, runs fhirpath-ts (with and without the R4 model), builds
and runs the Rust engine if `cargo` is available, and prints a comparison table.
Results land in `benchmarks/results/` (git-ignored).

Requirements: Node ≥ 22 (the harness imports the TS sources directly via Node's
type stripping). The Rust side additionally needs a Cargo toolchain; the first build
downloads the `octofhir-fhirpath` crate graph and takes a couple of minutes.

## What it measures

The workload is every official R4 case that expects a value (error-expectation cases
are dropped) **and** has an input fixture — 821 expression/resource pairs, so every
measurement is real-resource evaluation, not literal folding.

For each expression, each engine reports two per-op timings from warmed loops:

- **parse** — compiling the expression string to its internal form.
- **eval** — evaluating a pre-compiled/pre-parsed expression against its resource.
  Parsing is deliberately excluded here (compiled once, reused), because that is how
  both engines are meant to be used in a hot path.

Each engine also records whether it **accepted** each expression (compiled and
evaluated without throwing). The comparison table is computed over the set every
engine accepted, so no engine is scored on cases it can't run.

## Fairness notes

- **Model asymmetry.** fhirpath-ts runs model-aware by default (`r4Model`), which
  resolves choice types and polymorphic navigation — strictly more work than a
  model-unaware run. `octofhir-fhirpath` ships no embedded R4 schema, and wiring a
  real provider needs a network FHIR-package download, so the Rust harness uses its
  `EmptyModelProvider` (model-unaware). For a symmetric eval comparison, `bench-ts.ts
  --no-model` drops the model to match. The harness runs both fhirpath-ts modes so
  you can read the model-aware number, the apples-to-apples number, or both.
- **`trace()` cases are excluded** from the table: octofhir writes trace output to
  stdout, which would inflate the timing of those specific expressions.
- Both eval loops reuse a pre-parsed expression (`CompiledExpression` /
  `evaluate_ast`) and a pre-parsed resource, so the numbers isolate evaluation.
- The Rust harness is built `--release` with LTO; results fold in a checksum so the
  optimizer can't elide the work.

## Files

| File | Purpose |
|---|---|
| `run.sh` | Orchestrates the full comparison end to end. |
| `extract-workload.mjs` | Builds `results/workload.json` from the official R4 suite. |
| `bench-ts.ts` | fhirpath-ts harness; `--no-model` for the model-unaware run. |
| `rs-harness/` | Rust harness (`octofhir-fhirpath`), reads the same workload. |
| `compare.mjs` | Prints the comparison table over the common accepted set. |
| `results/` | Generated workload + per-engine result JSON (git-ignored). |

Each harness writes the same per-expression JSON record shape
(`{name, expression, accepted, parseNs, evalNs, error}`), so `compare.mjs` lines any
set of result files up by expression name.

## What the benchmark shows

An example run (expect ±20% between machines and runs):

- **Parsing:** fhirpath-ts is several times faster per expression than octofhir.
- **Eval, apples-to-apples** (both model-unaware): neck and neck — octofhir edges the
  median, fhirpath-ts has tighter tails, within ~10–15% in aggregate.
- **Eval, model-aware** fhirpath-ts vs model-unaware octofhir: octofhir is somewhat
  faster in aggregate, since the R4 model is real extra work fhirpath-ts is doing.

Re-run `benchmarks/run.sh` to reproduce on your machine.
