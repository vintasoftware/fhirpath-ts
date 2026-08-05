// Bundles fhirpath-ts's type declarations into self-contained .d.ts files that
// the Monaco playground feeds to its in-browser TypeScript worker. The library is
// consumed from source (no published .d.ts), so we roll each entry point up with
// dts-bundle-generator.
//
// The output is a build artifact, not a source file: `npm run dev` and
// `npm run build` both run this first (see the pre* scripts), and it is
// gitignored. The R4 rollup is ~44k lines of the same element table that
// src/r4/generated already holds — committing it would mean keeping a second copy
// in step with the first, and the playground's whole claim is that the reader's
// code is checked against the library's real types. Run it by hand with
//
//   npm run generate:dts

import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../..', import.meta.url))
const outDir = fileURLToPath(new URL('../src/monaco/', import.meta.url))
const out = name => `${outDir}${name}`
// The version comes from demo/package.json alone; naming one here too would let
// the two drift and quietly change what the bundles were built with.
const generator = fileURLToPath(new URL('../node_modules/.bin/dts-bundle-generator', import.meta.url))
// Not the repo root's tsconfig — see the comment in tsconfig.dts.json.
const project = fileURLToPath(new URL('../tsconfig.dts.json', import.meta.url))

// entry file (relative to the repo root) -> emitted bundle
const ENTRIES = [
  ['src/index.ts', out('fhirpath-ts.index.d.ts')],
  ['src/r4/index.ts', out('fhirpath-ts.r4.d.ts')],
  ['src/analyzer/index.ts', out('fhirpath-ts.analyzer.d.ts')],
]

// The directory holds nothing but these artifacts, so a fresh clone has no
// src/monaco at all — git does not track empty directories.
mkdirSync(outDir, { recursive: true })

for (const [entry, target] of ENTRIES) {
  console.log(`bundling ${entry} -> ${target}`)
  execFileSync(
    generator,
    ['--no-check', '--export-referenced-types=false', '--project', project, '-o', target, entry],
    { cwd: repo, stdio: 'inherit' }
  )
}

console.log('done')
