//! fhirpath-rs side of the cross-engine benchmark.
//!
//! Reads the shared workload.json, and for each case parses the expression once
//! (`parse_ast`) then times parse and eval (`evaluate_ast`) in warmed loops —
//! mirroring the fhirpath-ts harness. Emits the same per-expression record shape
//! so `compare.mjs` can line the two engines up.
//!
//! Runs with octofhir's `EmptyModelProvider` (model-unaware): the crate ships no
//! embedded R4 schema, and a real provider needs a network FHIR-package download.
//! Compare against fhirpath-ts's `--no-model` run for a symmetric result.
//!
//!   cargo run --release -- <workload.json> <out.json>
//!
//! Note: octofhir prints trace() output to stdout; compare.mjs excludes those cases.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use octofhir_fhirpath::{
    create_engine_with_empty_provider, parser, Collection, EvaluationContext, EmptyModelProvider,
    FhirPathValue,
};
use serde_json::Value;

const WARMUP: usize = 50;
const ITERS: usize = 2000;

#[derive(serde::Serialize)]
struct Rec {
    name: String,
    expression: String,
    accepted: bool,
    #[serde(rename = "parseNs")]
    parse_ns: Option<f64>,
    #[serde(rename = "evalNs")]
    eval_ns: Option<f64>,
    error: Option<String>,
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let workload_path = &args[1];
    let out_path = &args[2];

    let workload: Value =
        serde_json::from_str(&std::fs::read_to_string(workload_path).unwrap()).unwrap();
    let fixtures = workload["fixtures"].as_object().unwrap();
    let cases = workload["cases"].as_array().unwrap();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let engine = rt.block_on(create_engine_with_empty_provider()).unwrap();
    let model = Arc::new(EmptyModelProvider);

    // One context per distinct fixture (reused across cases sharing it).
    let mut contexts: HashMap<String, EvaluationContext> = HashMap::new();
    for (name, json) in fixtures {
        let coll = Collection::single(FhirPathValue::resource(json.clone()));
        let ctx = EvaluationContext::new(coll, model.clone(), None, None, None);
        contexts.insert(name.clone(), ctx);
    }

    let mut results: Vec<Rec> = Vec::new();
    let mut checksum: u64 = 0;
    let mut accepted_count = 0usize;

    for c in cases {
        let name = c["name"].as_str().unwrap().to_string();
        let expr = c["expression"].as_str().unwrap().to_string();
        let fixture = c["fixture"].as_str().unwrap();
        let ctx = contexts.get(fixture).unwrap();

        let mut rec = Rec {
            name: name.clone(),
            expression: expr.clone(),
            accepted: false,
            parse_ns: None,
            eval_ns: None,
            error: None,
        };

        // Parse timing
        let ast = match parser::parse_ast(&expr) {
            Ok(a) => a,
            Err(e) => {
                rec.error = Some(format!("parse: {e}").chars().take(200).collect());
                results.push(rec);
                continue;
            }
        };
        for _ in 0..WARMUP {
            let _ = parser::parse_ast(&expr);
        }
        let t = Instant::now();
        for _ in 0..ITERS {
            let _ = parser::parse_ast(&expr).unwrap();
        }
        rec.parse_ns = Some(t.elapsed().as_nanos() as f64 / ITERS as f64);

        // Eval check + timing (single block_on around the whole loop). The result
        // length is folded into a checksum so the optimizer can't elide the calls.
        let eval_outcome: Result<(f64, u64), String> = rt.block_on(async {
            match engine.evaluate_ast(&ast, ctx).await {
                Ok(_) => {}
                Err(e) => return Err(format!("eval: {e}").chars().take(200).collect()),
            }
            for _ in 0..WARMUP {
                let _ = engine.evaluate_ast(&ast, ctx).await;
            }
            let t = Instant::now();
            let mut sink: u64 = 0;
            for _ in 0..ITERS {
                let r = engine.evaluate_ast(&ast, ctx).await.unwrap();
                sink = sink.wrapping_add(r.value.len() as u64);
            }
            Ok((t.elapsed().as_nanos() as f64 / ITERS as f64, sink))
        });

        match eval_outcome {
            Ok((ns, sink)) => {
                rec.eval_ns = Some(ns);
                rec.accepted = true;
                accepted_count += 1;
                checksum = checksum.wrapping_add(sink);
            }
            Err(e) => {
                rec.error = Some(e);
            }
        }
        results.push(rec);
    }

    let out = serde_json::json!({
        "engine": "fhirpath-rs (octofhir 0.4.50)",
        "total": results.len(),
        "accepted": accepted_count,
        "results": results,
    });
    std::fs::write(out_path, serde_json::to_string(&out).unwrap()).unwrap();
    eprintln!(
        "fhirpath-rs: accepted {}/{} (checksum {})",
        accepted_count,
        results.len(),
        checksum
    );
}
