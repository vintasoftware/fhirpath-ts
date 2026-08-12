# Benchmarks

This benchmark compares **fhirpath-ts** with **fhirpath-rs**
([`octofhir-fhirpath`](https://crates.io/crates/octofhir-fhirpath), a
performance-focused Rust FHIRPath engine). It uses the official HL7 R4 cases and
fixtures in `test-data/official/r4`.

Run these benchmarks manually. They are not part of CI. Results depend on the
machine, so use them for relative comparisons and regression checks.

## Quick start

```sh
benchmarks/run.sh
```

The script extracts the workload, runs fhirpath-ts with and without the R4 model,
runs the Rust engine when Cargo is available, and prints a comparison table.
Results are written to the ignored `benchmarks/results/` directory.

Node 22 or later is required. The Rust run also needs Cargo. Its first build
downloads the `octofhir-fhirpath` dependency tree and can take several minutes.

## What it measures

The workload contains 821 official R4 expression and resource pairs. It includes
cases that expect a value and have an input fixture. Cases that expect errors are
excluded.

Each engine reports two timings from warmed loops:

- **parse**: compile the expression into its internal form.
- **eval**: evaluate a precompiled expression against its resource. Parsing is
  excluded because hot paths normally reuse a compiled expression.

Each engine records whether it compiled and evaluated an expression without an
error. The comparison includes only expressions accepted by every engine.

## Fairness notes

- **Model difference.** fhirpath-ts uses `r4Model` by default, which resolves
  choice types and polymorphic paths. `octofhir-fhirpath` uses its
  `EmptyModelProvider` because it does not include an R4 schema. Run
  `bench-ts.ts --no-model` for the closest comparison. The script reports both
  fhirpath-ts modes.
- **`trace()` cases are excluded** because octofhir writes trace output to stdout.
- Both evaluation loops reuse a parsed expression and resource.
- The Rust runner uses `--release` and LTO. A checksum prevents the optimizer
  from removing the measured work.

## Files

| File | Purpose |
|---|---|
| `run.sh` | Orchestrates the full comparison end to end. |
| `extract-workload.mjs` | Builds `results/workload.json` from the official R4 suite. |
| `bench-ts.ts` | fhirpath-ts runner; `--no-model` selects the model-free run. |
| `rs-harness/` | Rust runner (`octofhir-fhirpath`) for the same workload. |
| `compare.mjs` | Prints the comparison table over the common accepted set. |
| `summarize-runs.mjs` | Summarizes repeated run directories over their unchanged common accepted set. |
| `results/` | Generated workload + per-engine result JSON (git-ignored). |

Each runner writes `{name, expression, accepted, parseNs, evalNs, error}` for every
expression. `compare.mjs` joins result files by expression name.

## What the benchmark shows

An example run can vary by 20% or more between machines:

- **Parsing:** fhirpath-ts is several times faster per expression in the example.
- **Evaluation without models:** the engines are within about 10–15% overall.
  Octofhir has a slightly lower median; fhirpath-ts has tighter tail times.
- **Model-aware fhirpath-ts against model-free octofhir:** octofhir is faster
  overall because fhirpath-ts also performs R4 model work.

Re-run `benchmarks/run.sh` to reproduce on your machine.
