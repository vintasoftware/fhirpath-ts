#!/usr/bin/env bash
# End-to-end cross-engine benchmark: fhirpath-ts vs fhirpath-rs (octofhir) on the
# official HL7 R4 conformance corpus. Writes result JSON to benchmarks/results/ and
# prints a comparison table. The Rust engine is optional — skipped if cargo is absent.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p results

echo "==> extracting workload"
node extract-workload.mjs

echo "==> fhirpath-ts (r4 model)"
node bench-ts.ts

echo "==> fhirpath-ts (no model)"
node bench-ts.ts --no-model

if command -v cargo >/dev/null 2>&1; then
  echo "==> building fhirpath-rs harness (release; first build downloads crates)"
  cargo build --release --manifest-path rs-harness/Cargo.toml
  echo "==> fhirpath-rs (octofhir, EmptyModelProvider)"
  # octofhir writes trace() output to stdout; keep only our summary line.
  rs-harness/target/release/rs-harness results/workload.json results/rs.json 2>&1 | grep '^fhirpath-rs:' || true
else
  echo "==> cargo not found — skipping fhirpath-rs"
fi

echo
node compare.mjs
