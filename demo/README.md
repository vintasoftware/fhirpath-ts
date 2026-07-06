# fhirpath.ts playground

An interactive, client-only demo of [fhirpath-ts](../). Type a FHIRPath
expression, watch the spec §11 analyzer flag mistakes **before** the expression
runs, and see it evaluate against a synthetic FHIR resource — all in the browser,
with no server and no network calls.

The library is consumed straight from source (`../src`) through Vite aliases, so
the imports in `src/engine.ts` read exactly like real package usage:

```ts
import { compile } from 'fhirpath-ts'
import { r4Model } from 'fhirpath-ts/r4'
import { analyzeExpression } from 'fhirpath-ts/analyzer'
```

## Develop

```bash
cd demo
npm install
npm run dev      # http://localhost:5173
```

## Build

```bash
npm run build    # static site in demo/dist
npm run preview  # serve the built output locally
```

## Deploy to Cloudflare Pages

The output is fully static — no Worker, no Hono needed, because the engine is
zero-dependency and synchronous.

**From the dashboard:** create a Pages project pointed at this repo with

- Build command: `cd demo && npm install && npm run build`
- Build output directory: `demo/dist`

**From the CLI** (with [Wrangler](https://developers.cloudflare.com/workers/wrangler/)):

```bash
npm run build
npm run deploy   # wrangler pages deploy dist --project-name fhirpath-ts-demo
```
