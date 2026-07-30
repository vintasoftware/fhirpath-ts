// Bundles fhirpath-ts's type declarations into self-contained .d.ts files that
// the Monaco playground feeds to its in-browser TypeScript worker. The library
// is consumed from source (no published .d.ts), so we roll each entry point up
// with dts-bundle-generator. Regenerate after changing the library's types:
//
//   npm run generate:dts
//
// The output is committed so a plain `vite build` needs no extra tooling, and CI
// re-runs this to check the committed files still match the library's types.

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../..', import.meta.url))
const out = p => fileURLToPath(new URL(`../src/monaco/${p}`, import.meta.url))
// The version comes from demo/package.json alone; naming one here too would let
// the two drift and quietly change what the committed bundles were built with.
const generator = fileURLToPath(new URL('../node_modules/.bin/dts-bundle-generator', import.meta.url))

// entry file (relative to the repo root) -> emitted bundle
const ENTRIES = [
  ['src/r4/index.ts', out('fhirpath-ts.r4.d.ts')],
  ['src/analyzer/analyze.ts', out('fhirpath-ts.analyzer.d.ts')],
]

for (const [entry, target] of ENTRIES) {
  console.log(`bundling ${entry} -> ${target}`)
  execFileSync(generator, ['--no-check', '--export-referenced-types=false', '-o', target, entry], {
    cwd: repo,
    stdio: 'inherit',
  })
}

console.log('done')
