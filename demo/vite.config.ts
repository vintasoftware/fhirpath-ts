import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'

const src = (p: string) => fileURLToPath(new URL(`../src/${p}`, import.meta.url))

// The library is consumed from source (its package.json `main` is ./src/index.ts),
// so the demo imports it exactly the way a real dependent would — `fhirpath-ts`,
// `fhirpath-ts/r4`, `fhirpath-ts/analyzer` — with the subpaths aliased to source.
// Longer specifiers come first: Vite resolves aliases top-to-bottom by prefix.
export default defineConfig({
  base: './',
  resolve: {
    alias: [
      { find: 'fhirpath-ts/analyzer', replacement: src('analyzer/analyze.ts') },
      { find: 'fhirpath-ts/r4', replacement: src('r4/index.ts') },
      { find: 'fhirpath-ts', replacement: src('index.ts') },
    ],
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
})
