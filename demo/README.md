# fhirpath-ts playground

The playground is a client-only demonstration of the engine, TypeScript
inference, and the [specification §11 analyzer](https://hl7.org/fhirpath/en/index.html#type-safety-and-strict-evaluation).
It runs entirely in the browser.
No FHIR data is sent to a server.
Type inference computes safe TypeScript types; the analyzer reports expression errors.
Literal host values infer automatically; `envTypes` and `varTypes` handle ambiguous values.

Try the [live playground](https://vintasoftware.github.io/fhirpath-ts/).

Use it to explore:

- evaluation against editable R4 resources;
- input and result types inferred for literal paths, operators, functions, and variables;
- parser, type, cardinality, and unknown-element diagnostics;
- `test`, `filter`, `checkConstraints`, and `project` behavior;
- Bundle navigation and reference resolution;
- exact decimal, date, time, Quantity, and UCUM behavior;
- fixed clocks and `trace()` output;
- DTO-style application projections shown in the samples.

The repository README keeps its recipes short and points here for interactive
examples.

## Package imports

The demo imports the library from `../src` through Vite aliases. Its application
code uses the same package entry points as a consumer:

```ts
import { compile } from 'fhirpath-ts'
import { r4Model } from 'fhirpath-ts/r4'
import { analyzeExpression } from 'fhirpath-ts/analyzer'

const names = compile('Patient.name.given')
```

## Develop

```bash
cd demo
npm install
npm run dev
```

The development server starts at `http://localhost:5173` by default.

## Build

```bash
npm run build
npm run preview
```

The static output is written to `demo/dist`.

## Monaco declarations

The editor checks sample code against declarations generated from the library's
public API. `scripts/generate-dts.mjs` writes the declaration bundle to
`src/monaco/*.d.ts` before development and production builds.

Run the declaration step by itself after changing the public API:

```bash
npm run generate:dts
```

The generated files are ignored by Git.

## Deployment

The output is a static site. It does not require a Worker or an application
server. Vite uses relative asset paths, so the same build works at the
`/fhirpath-ts/` GitHub project path and at other deployment paths.

### GitHub Pages

The [Pages workflow](../.github/workflows/pages.yml) builds `demo/`, uploads
`demo/dist`, and deploys it after each push to `main`. It can also be run
manually from the Actions tab.

Before the first deployment, select **GitHub Actions** as the source under
**Settings → Pages → Build and deployment**. No branch containing generated
assets is required.

### Cloudflare Pages

Cloudflare Pages can use:

- Build command: `cd demo && npm install && npm run build`
- Build output directory: `demo/dist`

The existing CLI deployment command targets Cloudflare Pages:

```bash
npm run build
npm run deploy
```
